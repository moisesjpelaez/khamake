"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.set = set;
exports.silent = silent;
exports.info = info;
exports.error = error;
let myInfo = function (text, newline) {
    if (newline) {
        console.log(text);
    }
    else {
        process.stdout.write(text);
    }
};
let myError = function (text, newline) {
    if (newline) {
        console.error(text);
    }
    else {
        process.stderr.write(text);
    }
};
function set(log) {
    myInfo = log.info;
    myError = log.error;
}
function silent(showErrors = false) {
    myInfo = function () { };
    if (!showErrors) {
        myError = function () { };
    }
}
function info(text, newline = true) {
    myInfo(text, newline);
}
function error(text, newline = true) {
    myError(text, newline);
}
//# sourceMappingURL=log.js.map