import { Callbacks } from './ProjectFile';
import * as fs from 'fs-extra';
import * as path from 'path';
import { KhaExporter } from './Exporters/KhaExporter';
import * as log from './log';
import * as chokidar from 'chokidar';
import * as crypto from 'crypto';
import * as Throttle from 'promise-parallel-throttle';
import { Options } from './Options';
import { AssetMatcher, AssetMatcherOptions } from './Project';

export type AssetType = 'image' | 'sound' | 'video' | 'font' | 'blob' | 'shader';

export type AssetInfo = {
	name: string;
	from?: string;
	type: AssetType;
	files: string[];
	file_sizes: number[];
	original_width?: number;
	original_height?: number;
	readable?: boolean;

	inputs?: any;
	outputs?: any;
	uniforms?: any;
	types?: any;
};

export const supportedAssetExtensions = [
	'.png', '.jpg', '.jpeg', '.hdr',
	'.ogg', '.mp3', '.flac', '.wav',
	'.mp4', '.webm', '.mov', '.wmv', '.avi',
	'.ttf'
];

export class AssetConverter {
	options: Options;
	exporter: KhaExporter;
	platform: string;
	assetMatchers: Array<AssetMatcher>;
	watcher?: fs.FSWatcher;
	onAssetChanged?: (asset: AssetInfo) => void;
	onAssetRemoved?: (name: string) => void;

	constructor(exporter: KhaExporter, options: Options, assetMatchers: Array<AssetMatcher>) {
		this.exporter = exporter;
		this.options = options;
		this.platform = options.target;
		this.assetMatchers = assetMatchers;
	}

	close(): void {
		if (this.watcher) this.watcher.close();
	}

	static replacePattern(pattern: string, name: string, fileinfo: path.ParsedPath, options: AssetMatcherOptions, from: string) {
		let basePath: string = options.nameBaseDir ? path.join(from, options.nameBaseDir) : from;
		let dirValue: string = path.relative(basePath, fileinfo.dir);
		if (basePath.length > 0 && basePath[basePath.length - 1] === path.sep
			&& dirValue.length > 0 && dirValue[dirValue.length - 1] !== path.sep) {
			dirValue += path.sep;
		}
		if (options.namePathSeparator) {
			dirValue = dirValue.split(path.sep).join(options.namePathSeparator);
		}

		const dirRegex = dirValue === ''
			? /{dir}\//g
			: /{dir}/g;

		return pattern.replace(/{name}/g, name).replace(/{ext}/g, fileinfo.ext).replace(dirRegex, dirValue);
	}

	static createExportInfo(fileinfo: path.ParsedPath, keepextension: boolean, options: AssetMatcherOptions, from: string): { name: string, destination: string } {
		let nameValue = fileinfo.name;

		let destination = fileinfo.name;

		if (options.md5sum) {
			let data = fs.readFileSync(path.join(fileinfo.dir, fileinfo.base));
			let md5sum = crypto.createHash('md5').update(data).digest('hex'); // TODO yield generateMd5Sum(file);
			destination += '_' + md5sum;
		}
		if ((keepextension || options.noprocessing) && (!options.destination || options.destination.indexOf('{ext}') < 0)) {
			destination += fileinfo.ext;
		}

		if (options.destination) {
			destination = AssetConverter.replacePattern(options.destination, destination, fileinfo, options, from);
		}

		if (options.destinationCallback) {
			destination = options.destinationCallback(destination);
		}

		if (keepextension && (!options.name || options.name.indexOf('{ext}') < 0)) {
			nameValue += fileinfo.ext;
		}

		if (options.name) {
			nameValue = AssetConverter.replacePattern(options.name, nameValue, fileinfo, options, from);
		}

		return { name: nameValue, destination: destination };
	}

	canDecodeFormat(ext: string): boolean {
		// without ffmpeg we need to encode mp3 and ogg files
		const hasFFmpeg = !!this.options.ffmpeg;
		const hasFFmpegOgg = this.options.ogg?.includes('ffmpeg') ?? false;
		const hasFFmpegMp3 = this.options.mp3?.includes('ffmpeg') ?? false;
		const hasFFmpegAac = this.options.aac?.includes('ffmpeg') ?? false;
		switch (ext) {
			case '.wav':
				return true;
			case '.ogg':
				return hasFFmpeg || (hasFFmpegOgg && (hasFFmpegMp3 || hasFFmpegAac));
			case '.mp3':
				// lame can decode mp3, so we only need ogg ffmpeg encoder
				return hasFFmpeg || (hasFFmpegOgg && !!this.options.mp3);
			case '.flac':
				return hasFFmpeg;
			default:
				return false;
		}
	}

	watch(watch: boolean, match: string, temp: string, options: AssetMatcherOptions): Promise<AssetInfo[]> {
		return new Promise<AssetInfo[]>((resolve, reject) => {
			let ready = false;
			let files: string[] = [];
			this.watcher = chokidar.watch(match, { ignored: /[\/\\]\.(svn|git|DS_Store)/, persistent: watch, followSymlinks: false });

			const onFileChange = async (file: string) => {
				const fileinfo = path.parse(file);
				let outPath = fileinfo.name;
				// with subfolders
				if (options.destination) {
					// remove trailing slash
					const nameBaseDir = options.nameBaseDir!.replace(/\/$/, '');
					const lastIndex = options.baseDir!.lastIndexOf(nameBaseDir)
					const from = path.resolve(options.baseDir!.substring(0, lastIndex));
					outPath = AssetConverter.replacePattern(options.destination, fileinfo.name, fileinfo, options, from);
				}
				const ext = fileinfo.ext.toLowerCase();
				log.info('Reexporting ' + outPath + ext);

				let result: { files: string[], sizes: number[] } | null = null;
				const assetType = AssetConverter.getExtensionAssetType(ext);

				switch (assetType) {
					case 'image':
						result = await this.exporter.copyImage(this.platform, file, outPath, {}, {});
						break;
					case 'sound':
						if (!this.canDecodeFormat(ext)) {
							log.error(`Error: ${fileinfo.base} should be in wav format, or use \`--ffmpeg path/to/ffmpeg\` option to convert ogg/mp3/flac files`);
						}
						result = await this.exporter.copySound(this.platform, file, outPath, {});
						break;
					case 'video':
						result = await this.exporter.copyVideo(this.platform, file, outPath, {});
						break;
					case 'font':
						result = await this.exporter.copyFont(this.platform, file, outPath, {});
						break;
					case 'blob':
						result = await this.exporter.copyBlob(this.platform, file, outPath + ext, {});
						break;
					case 'shader':
						break;
				}

				if (result && this.onAssetChanged) {
					const isKeepExt = assetType === 'blob';
					const exportInfo = AssetConverter.createExportInfo(fileinfo, isKeepExt, options, this.exporter.options.from);
					this.onAssetChanged({
						name: exportInfo.name,
						from: file,
						type: assetType,
						files: result.files,
						file_sizes: result.sizes,
						original_width: options.original_width,
						original_height: options.original_height,
						readable: options.readable
					});
				}

				for (let callback of Callbacks.postAssetReexporting) {
					callback(outPath + ext);
				}
			};

			this.watcher.on('add', (file: string) => {
				if (ready) {
					onFileChange(file);
				}
				else {
					files.push(file);
				}
			});
			if (watch) {
				this.watcher.on('change', (file: string) => {
					if (ready) {
						onFileChange(file);
					}
				});
			}
			this.watcher.on('unlink', (file: string) => {
				if (!this.onAssetRemoved) return;
				const fileinfo = path.parse(file);
				const ext = fileinfo.ext.toLowerCase();
				const keepExt = !supportedAssetExtensions.includes(ext);
				const exportInfo = AssetConverter.createExportInfo(fileinfo, keepExt, options, this.exporter.options.from);
				this.onAssetRemoved(exportInfo.name);
			});
			this.watcher.on('ready', async () => {
				ready = true;
				let parsedFiles: AssetInfo[] = [];
				let cache: any = {};
				let cachePath = path.join(temp, 'cache.json');
				if (fs.existsSync(cachePath)) {
					cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
				}

				const convertAsset = async (file: string, index: number) => {
					let fileinfo = path.parse(file);
					log.info('Exporting asset ' + (index + 1) + ' of ' + files.length + ' (' + fileinfo.base + ').');
					const ext = fileinfo.ext.toLowerCase();
					const assetType = AssetConverter.getExtensionAssetType(ext);
					switch (assetType) {
						case 'image': {
							let exportInfo = AssetConverter.createExportInfo(fileinfo, false, options, this.exporter.options.from);
							let imageOptions = Object.assign({}, options);
							let images: { files: string[], sizes: number[] };
							if (imageOptions.noprocessing) {
								images = await this.exporter.copyBlob(this.platform, file, exportInfo.destination, imageOptions);
							}
							else {
								images = await this.exporter.copyImage(this.platform, file, exportInfo.destination, imageOptions, cache);
							}
							if (!imageOptions.notinlist) {
								parsedFiles.push({ name: exportInfo.name, from: file, type: 'image', files: images.files, file_sizes: images.sizes, original_width: imageOptions.original_width, original_height: imageOptions.original_height, readable: imageOptions.readable });
							}
							break;
						}
						case 'sound': {
							let exportInfo = AssetConverter.createExportInfo(fileinfo, false, options, this.exporter.options.from);
							let sounds: { files: string[], sizes: number[] };
							if (options.noprocessing) {
								sounds = await this.exporter.copyBlob(this.platform, file, exportInfo.destination, options);
							}
							else {
								if (!this.canDecodeFormat(ext)) {
									log.error(`Error: ${fileinfo.base} should be in wav format, or use \`--ffmpeg\` option to convert ogg/mp3/flac files`);
									process.exit(1);
								}
								sounds = await this.exporter.copySound(this.platform, file, exportInfo.destination, options);
							}
							if (sounds.files.length === 0) {
								throw 'Audio file ' + file + ' could not be exported, you have to specify a path to ffmpeg.';
							}
							if (!options.notinlist) {
								parsedFiles.push({ name: exportInfo.name, from: file, type: 'sound', files: sounds.files, file_sizes: sounds.sizes, original_width: undefined, original_height: undefined, readable: undefined });
							}
							break;
						}
						case 'font': {
							let exportInfo = AssetConverter.createExportInfo(fileinfo, false, options, this.exporter.options.from);
							let fonts: { files: string[], sizes: number[] };
							if (options.noprocessing) {
								fonts = await this.exporter.copyBlob(this.platform, file, exportInfo.destination, options);
							}
							else {
								fonts = await this.exporter.copyFont(this.platform, file, exportInfo.destination, options);
							}
							if (!options.notinlist) {
								parsedFiles.push({ name: exportInfo.name, from: file, type: 'font', files: fonts.files, file_sizes: fonts.sizes, original_width: undefined, original_height: undefined, readable: undefined });
							}
							break;
						}
						case 'video': {
							let exportInfo = AssetConverter.createExportInfo(fileinfo, false, options, this.exporter.options.from);
							let videos: { files: string[], sizes: number[] };
							if (options.noprocessing) {
								videos = await this.exporter.copyBlob(this.platform, file, exportInfo.destination, options);
							}
							else {
								videos = await this.exporter.copyVideo(this.platform, file, exportInfo.destination, options);
							}
							if (videos.files.length === 0) {
								log.error('Video file ' + file + ' could not be exported, you have to specify a path to ffmpeg.');
							}
							if (!options.notinlist) {
								parsedFiles.push({ name: exportInfo.name, from: file, type: 'video', files: videos.files, file_sizes: videos.sizes, original_width: undefined, original_height: undefined, readable: undefined });
							}
							break;
						}
						case 'blob': {
							let exportInfo = AssetConverter.createExportInfo(fileinfo, true, options, this.exporter.options.from);
							let blobs = await this.exporter.copyBlob(this.platform, file, exportInfo.destination, options);
							if (!options.notinlist) {
								parsedFiles.push({ name: exportInfo.name, from: file, type: 'blob', files: blobs.files, file_sizes: blobs.sizes, original_width: undefined, original_height: undefined, readable: undefined });
							}
							break;
						}
					}
				}

				if (this.options.parallelAssetConversion !== 0) {
					let todo = files.map((file, index) => {
						return async () => {
							await convertAsset(file, index);
						};
					});

					let processes = this.options.parallelAssetConversion === -1
						? require('os').cpus().length - 1
						: this.options.parallelAssetConversion;

					await Throttle.all(todo, {
						maxInProgress: processes,
					});
				} else {
					let index = 0;
					for (let file of files) {
						await convertAsset(file, index);
						index += 1;
					}
				}

				fs.ensureDirSync(temp);
				fs.writeFileSync(cachePath, JSON.stringify(cache), { encoding: 'utf8' });
				resolve(parsedFiles);
			});
		});
	}

	static getExtensionAssetType(ext: string): AssetType {
		switch (ext) {
			case '.png':
			case '.jpg':
			case '.jpeg':
			case '.hdr':
				return 'image';
			case '.ogg':
			case '.mp3':
			case '.flac':
			case '.wav':
				return 'sound';
			case '.mp4':
			case '.webm':
			case '.mov':
			case '.wmv':
			case '.avi':
				return 'video';
			case '.ttf':
				return 'font';
			default:
				return 'blob';
		}
	}

	async run(watch: boolean, temp: string): Promise<AssetInfo[]> {
		let files: AssetInfo[] = [];
		for (let matcher of this.assetMatchers) {
			files = files.concat(await this.watch(watch, matcher.match, temp, matcher.options));
		}
		return files;
	}
}
