"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.init = init;
exports.get = get;
const path = require("path");
const exec_1 = require("./exec");
let korepath = path.join(__dirname, '..', '..', '..', 'Kore', 'Tools', (0, exec_1.sysdir)());
function init(options) {
    korepath = path.join(options.kha, 'Kore', 'Tools', (0, exec_1.sysdir)());
}
function get() {
    return korepath;
}
//# sourceMappingURL=korepath.js.map