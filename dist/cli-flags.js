"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGlobalFlags = parseGlobalFlags;
const VERSION_FLAGS = new Set(["--version", "--v", "-version", "-v"]);
const VERBOSE_FLAGS = new Set(["--verbose", "--verbose=true"]);
const JSON_FLAGS = new Set(["--json", "--json=true"]);
const JSON_REQUEST_FLAGS = new Set(["--json-request", "--json-request=true"]);
const JSON_RESPONSE_FLAGS = new Set(["--json-response", "--json-response=true"]);
function parseGlobalFlags(argv) {
    const options = {
        version: false,
        verbose: false,
        jsonRequest: false,
        jsonResponse: false,
    };
    const remainingArgs = [];
    for (const arg of argv) {
        if (VERSION_FLAGS.has(arg)) {
            options.version = true;
        }
        else if (VERBOSE_FLAGS.has(arg)) {
            options.verbose = true;
        }
        else if (JSON_FLAGS.has(arg)) {
            options.jsonRequest = true;
            options.jsonResponse = true;
        }
        else if (JSON_REQUEST_FLAGS.has(arg)) {
            options.jsonRequest = true;
        }
        else if (JSON_RESPONSE_FLAGS.has(arg)) {
            options.jsonResponse = true;
        }
        else {
            remainingArgs.push(arg);
        }
    }
    return { options, remainingArgs };
}
