/**
 * Starts a server which serves the contents of platforms/android/app/src/main/assets/www excluding local plugins.
 *
 * local plugins are plugins installed from a local file (aka. in package.json, their entry begins with "file:"")
 * Local plugins have their files initially replicated into the /.hot_reload_js_files directory.
 * The local plugin dir (referenced in package.json) is then monitored for changes.
 * When any file in a local plugin is changed it is re-copied into the .hot_reload_js_files dir.
 * The plugins in .hot_reload_js_files dir are hosted in place of their unchanging counterpart in platforms/android/app/src/main/assets/www.
 *
 * Files that are copied into the .hot_reload_js_files dir may need to have certain operations applied to them to
 * replicate the changes they receive when being installed normally.
 * The only special operation that we explicitly handle currently are files marked as "js-module" in plugin.xml
 * js-module files have a line code add to the beginning and end of the file.
 *
 * To make use of this file just:
 * - navigate to, or request a file hosted by hot-reload using:
 *   - eg. http://192.168.1.107:8333/index.html
 *   - instead of file:///android_asset/www/index.html
 *
 * You can check the contents of .hot_reload_js_files for troubleshooting (it is in the project root by default)
 *
 * Usage:
 * `node ./scripts/hot-reload-js.js <platform> [<port default=8333>]` (currently only available for android)
 */
(function () {
    'use strict';

    var fs = require('fs-extra');
    var path = require('path');
    var express = require('express');
    var et = require('elementtree');
    var watch = require('node-watch');

    var ASSET_DIR = {
        android: path.resolve(__dirname, '../platforms/android/app/src/main/assets/www/'),
        ios: path.resolve(__dirname, '../platforms/ios/www') // TODO add actual path
    };
    var COPIES_DIR = path.resolve(__dirname, '../.hot_reload_js_files');

    var _server;
    var _platform;
    var _port = 8333;
    var _opFiles = {}; // Files that need special operations
    var _plugins;

    // process the passed arguments and configure options
    if (process.argv.indexOf('android') > -1) {
        _platform = 'android';
    } else if (process.argv.indexOf('ios') > -1) {
        _platform = 'ios';
    } else {
        return console.error('No valid platform found!  Expected "android" or "ios" as an argument');
    }
    if (process.argv.length >= 4) {
        _port = process.argv[3];
    }

    // Configure options
    ASSET_DIR = ASSET_DIR[_platform];

    // remove and reset hot_reload_files dir
    try {
        fs.removeSync(COPIES_DIR);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }

    // Get all local plugins
    getLocalPlugins();

    var plugin;
    for (var name in _plugins) {
        plugin = _plugins[name];

        // Store any js modules in the global
        initOpFiles(plugin);

        var shouldWatchDir = true;
        for (var p in _plugins) {
            p = _plugins[p];
            // If this plugin is contained within an any other local plugin
            if (plugin.path !== p.path && plugin.path.startsWith(p.path)) {
                // We don't want to watch this dir since it will/already is watched
                shouldWatchDir = false;
                break;
            }
        }
        if (shouldWatchDir) {
            // And watch the original directory for changes
            watchDir(plugin.path);
        }
    }

    // Finally, start the server
    startServer();

    //* ****************************************************************************************
    //* ************************************** Functions ***************************************
    //* ****************************************************************************************

    function getLocalPlugins () {
        // Reset the global plugins
        _plugins = {};

        // Read the package
        var entries = fs.readJSONSync(path.resolve(__dirname, '../package.json')).dependencies;

        // Go through all the plugins
        var loc;
        for (var name in entries) {
            loc = entries[name];
            // Is it a local plugin?
            if (loc.startsWith('file:')) {
                // Add it
                _plugins[name] = {
                    name: name,
                    path: path.resolve(__dirname, '..', loc.substring(5))};
            }
        }
    }

    /**
     * Parses through a plugin's plugin.xml file to find files that need
     * special operations applied.
     *
     * @param {object} plugin - Represents a plugin
     * @property {string} name
     * @property {string} loc
     */
    function initOpFiles (plugin) {
        var etree;

        etree = fs.readFileSync(path.resolve(plugin.path, 'plugin.xml')).toString();
        etree = et.parse(etree);

        addOpFilesOfTag(etree, 'js-module');
        addOpFilesOfTag(etree, 'asset');
    }

    function addOpFilesOfTag (etree, tagName) {
        // Find all global modules
        var tags = etree.findall(tagName) || [];
        // Find and add all platform specific modules
        etree = etree.find('platform/[@name="' + _platform + '"]');
        etree = etree ? etree.find(tagName) : null;
        if (etree && etree.length > 0) {
            tags.push(etree);
        }
        for (var e in tags) {
            e = tags[e];
            var src_absolute = path.resolve(plugin.path, e.attrib.src);
            e = {
                src_absolute: src_absolute,
                src: e.attrib.src,
                name: e.attrib.name,
                target: e.attrib.target,
                type: tagName
            };

            // special tag handling:
            switch (tagName) {
            case 'asset':
                // If the source is a file and the target is a directory
                if (!fs.lstatSync(src_absolute).isDirectory() && fs.lstatSync(path.join(ASSET_DIR, e.target)).isDirectory()) {
                    // Append the target path
                    e.target = path.join(e.target, path.basename(src_absolute));
                }
                break;
            }

            _opFiles[src_absolute] = e;

            // Make initial copy of opFile
            updateFileCopy(src_absolute);
        }
    }

    /**
     * Decides whether a path should be watched or not.
     * @param {string} filePath
     * @returns {boolean}
     */
    function shouldWatchPath (filePath) {
        return getOpRulesForFile(filePath).length !== 0;
    }

    function getOpRulesForFile (filePath) {
        var rules = [];
        // Check all opFile paths
        for (var p in _opFiles) {
            // If the file resides in, or is an exact match for an opFile
            if (filePath.startsWith(p)) {
                rules.push(_opFiles[p]);
            }
        }
        return rules;
    }

    /**
     * Returns the path that the copy should be made at
     * @param {opRule} rule
     * @param {string} filePath - path of the original file
     */
    function getTargetPath (rule, filePath) {
        switch (rule.type) {
        case 'js-module':
            var plugin = getPluginByFile(filePath);
            return path.resolve(COPIES_DIR, 'plugins', plugin.name, path.relative(plugin.path, filePath));
        case 'asset':
            return path.resolve(COPIES_DIR, rule.target, path.relative(rule.src_absolute, filePath));
        }
    }

    /**
     * Copies/converts the file so it will work with the cordova framework.
     *
     * @param {String} filePath
     */
    function updateFileCopy (filePath) {
        // Does the file need a special operation?
        var rules = getOpRulesForFile(filePath);
        for (var i = 0; i < rules.length; i++) {
            var rule = rules[i];

            switch (rule.type) {
            case 'js-module':
                var fileData = fs.readFileSync(filePath, 'utf-8');
                if (rule.src.match(/.*\.json$/)) {
                    fileData = 'module.exports = ' + fileData;
                }
                fileData = 'cordova.define("' + plugin.name + '.' + rule.name + '", function(require, exports, module) { \n' + fileData + '\n});\n';
                fs.outputFileSync(getTargetPath(rule, filePath), fileData, 'utf-8');
                break;
            case 'asset':
                fs.copySync(filePath, getTargetPath(rule, filePath), { overwrite: true });
                break;
            }
        }
    }

    /**
     * Removes the corresponding file copy.
     *
     * @param {String} filePath
     */
    function removeFileCopy (filePath) {
        var rules = getOpRulesForFile(filePath);
        for (var i = 0; i < rules.length; i++) {
            fs.removeSync(getTargetPath(rules[i], filePath));
        }
    }

    /**
     * Recursively looks for the plugin with the deepest directory that matches the filePath.
     * This strategy works for nested plugins.  It will prefer to match with the deepest nested
     * plugin, rather than the parent.
     *
     * @param {string} filePath - the file to find it's plugin's folder
     * @param {string} originalPath - for internal use only
     */
    function getPluginByFile (filePath, originalPath) {
        originalPath = originalPath || filePath;
        // If there is nowhere left to go up in the path basically
        if (path.dirname(filePath) === filePath) {
            throw new Error('Could not find a local plugin that contains this file path: ' + originalPath);
        }
        for (var p in _plugins) {
            p = _plugins[p];
            // Does the plugin path match the file path exactly?
            if (path.relative(p.path, filePath) === '') {
                return p;
            }
        }
        return getPluginByFile(path.dirname(filePath), originalPath);
    }

    function watchDir (dir) {
        watch(dir, { recursive: true }, function (eventType, filename) {
            if (!shouldWatchPath(filename)) { return; }

            if (eventType === 'update') {
                console.log(new Date().toLocaleString() + ': Change detected at: ' + filename);
                updateFileCopy(filename);
            }
            if (eventType === 'remove') {
                console.log(new Date().toLocaleString() + ': Delete detected at: ' + filename);
                removeFileCopy(filename);
            }
        });
    }

    function startServer () {
        _server = express();

        // Add COPIES_DIR first so it is used before the ASSET_DIR
        _server.use('/', express.static(COPIES_DIR));
        _server.use('/', express.static(ASSET_DIR));

        // Start the server
        _server.listen(_port, function () {
            console.log('Server listening on port ', _port);
        });
    }

})();
