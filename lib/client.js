"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var path = require("upath");
var events_1 = require("events");
var FTP = require("ftp");
var _ = require("lodash");
var glob = require("glob");
var rxjs_1 = require("rxjs");
var operators_1 = require("rxjs/operators");
var loggingLevels = ['none', 'basic', 'debug'];
var Client = /** @class */ (function () {
    function Client(config, options) {
        var _this = this;
        this.config = {
            host: 'localhost',
            port: 21,
            user: 'anonymous',
            password: 'anonymous@',
        };
        this.options = {
            overwrite: 'older',
            testingTimezoneDir: null,
            globOptions: {
                nonull: false,
            },
            logging: 'basic',
            logger: console,
            disconnect: true,
        };
        this.MAX_CONNECTIONS = 10;
        this.status = 'disconnected';
        this.events = new events_1.EventEmitter();
        this.setConfig(config, options);
        this.ftp = new FTP();
        this.errorObservable = new rxjs_1.Observable(function (observer) {
            _this.ftp.removeAllListeners('error');
            _this.ftp.on('error', function (err) {
                _this.testEmitError(err, 'Error - ' + JSON.stringify(err), 'basic');
                // XXX Check if throwing the error stops everything
                observer.error(err);
            });
        });
    }
    Client.prototype.log = function (msg, lvl, type) {
        if (lvl === void 0) { lvl = 'basic'; }
        if (type === void 0) { type = 'info'; }
        if (loggingLevels.indexOf(lvl) <= loggingLevels.indexOf(this.options.logging)) {
            this.options.logger[type](msg);
        }
    };
    /**
     * Emit the error, return the output of the callback function or true if there
     * is any error or false if there isn't
     * @param  err Error
     */
    Client.prototype.testEmitError = function (err, msg, lvl, callback) {
        if (lvl === void 0) { lvl = 'debug'; }
        if (err) {
            this.events.emit('error', err);
            this.log(msg ? msg : err, lvl, 'error');
            if (callback) {
                var out = callback(err);
                if (out) {
                    return out;
                }
            }
            return true;
        }
        return false;
    };
    Client.prototype.fileExist = function (path) {
        return rxjs_1.bindNodeCallback(function (dir, callBack) {
            fs.access(dir, fs.constants.F_OK, function (err) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        callBack(null, false);
                        return false;
                    }
                    else {
                        callBack(err);
                    }
                }
                else {
                    callBack(null, true);
                    return true;
                }
            });
        }).call(this, path);
    };
    Client.prototype.checkTimezone = function () {
        var _this = this;
        var localTime = new Date().getTime();
        var serverTime;
        var timestampPath = '.timestamp';
        timestampPath = this.options.testingTimezoneDir
            ? path.join(this.options.testingTimezoneDir, timestampPath)
            : timestampPath;
        var manageError = function (err) {
            return _this.testEmitError(err, 'Error - ' + JSON.stringify(err), 'debug', function () {
                return rxjs_1.of(null);
            });
        };
        return rxjs_1.race(this.errorObservable, rxjs_1.of(null).pipe(operators_1.switchMapTo(rxjs_1.bindNodeCallback(this.ftp.put)
            .call(this.ftp, new Buffer('blank'), timestampPath)
            .pipe(operators_1.catchError(function (err) {
            return manageError(err);
        }))), operators_1.switchMapTo(rxjs_1.bindNodeCallback(this.ftp.list)
            .call(this.ftp, timestampPath)
            .pipe(operators_1.catchError(function (err) {
            return manageError(err);
        }), operators_1.tap(function (list) {
            if (list && list[0] && list[0].date) {
                serverTime = list[0].date.getTime();
            }
        }))), operators_1.switchMapTo(rxjs_1.bindNodeCallback(this.ftp.delete)
            .call(this.ftp, timestampPath)
            .pipe(operators_1.catchError(function (err) {
            return manageError(err);
        }))), operators_1.tap(function () {
            _this.serverTimeDif = localTime - serverTime;
            _this.log('Server time is ' +
                new Date(new Date().getTime() - _this.serverTimeDif), 'debug');
        }), operators_1.first()));
    };
    Client.prototype.glob = function (patterns, options) {
        options = _.defaults(options || {}, this.options.globOptions);
        var include = [];
        var exclude = [];
        if (!_.isArray(patterns)) {
            patterns = [patterns];
        }
        patterns.forEach(function (pattern) {
            if (pattern.indexOf('!') === 0) {
                exclude = exclude.concat(glob.sync(pattern.substring(1), options) || []);
            }
            else {
                include = include.concat(glob.sync(pattern, options) || []);
            }
        });
        return _.difference(include, exclude);
    };
    Client.prototype.clean = function (files, baseDir) {
        if (!baseDir) {
            return files;
        }
        return _.compact(_.map(files, function (file) {
            if (file.replace(baseDir, '')) {
                return file;
            }
            else {
                return null;
            }
        }));
    };
    Client.prototype.stat = function (files) {
        var result = [[], []];
        _.each(files, function (f) {
            var file = _.extend(fs.statSync(f), {
                src: f,
            });
            if (file.isDirectory()) {
                result[0].push(file);
            }
            else {
                result[1].push(file);
            }
        });
        return result;
    };
    Client.prototype.cwd = function (pathRemote) {
        var _this = this;
        return rxjs_1.race(this.errorObservable, new rxjs_1.Observable(function (observer) {
            _this.ftp.mkdir.call(_this.ftp, pathRemote, true, function (err1) {
                _this.testEmitError(err1);
                _this.ftp.cwd.call(_this.ftp, pathRemote, function (err2) {
                    _this.testEmitError(err2);
                    observer.next();
                    observer.complete();
                });
            });
        }));
    };
    Client.prototype.cleanDestPath = function (pathIn, baseDir) {
        pathIn = path.normalizeTrim(pathIn);
        baseDir = path.normalizeTrim(baseDir);
        return pathIn.indexOf(baseDir) === 0
            ? pathIn.substring(baseDir.length + 1)
            : pathIn;
    };
    Client.prototype.forkJoinLimit = function (limit, sources) {
        if (sources.length < limit) {
            return rxjs_1.forkJoin(sources);
        }
        return _.reduce(_.chunk(sources, limit), function (acc, subSource) {
            acc = acc.pipe(operators_1.concatMap(function (val) {
                return rxjs_1.forkJoin(subSource).pipe(operators_1.map(function (val2) { return (val ? _.concat(val, val2) : val2); }));
            }));
            return acc;
        }, rxjs_1.of(null));
    };
    Client.prototype.endObservable = function (options, optionsBk) {
        var _this = this;
        return rxjs_1.iif(function () { return options.disconnect; }, this.disconnect(), rxjs_1.of(null)).pipe(operators_1.tap(function () { return (_this.options = optionsBk); }));
    };
    Client.prototype.setConfig = function (config, options) {
        if (this.status === 'connected') {
            throw new Error('You cannot change the config while you are connected');
        }
        this.config = _.defaults(config || {}, this.config);
        this.options = _.defaults(options || {}, this.options);
    };
    Client.prototype.connect = function () {
        var _this = this;
        return rxjs_1.race(this.errorObservable, new rxjs_1.Observable(function (observer) {
            _this.ftp.once('ready', function () {
                _this.log('Connected to ' + _this.config.host, 'debug');
                _this.log('Checking server local time...', 'debug');
                observer.next();
                observer.complete();
            });
            _this.ftp.connect.call(_this.ftp, _this.config);
        }).pipe(operators_1.switchMapTo(this.checkTimezone()), operators_1.tap(function () {
            _this.status = 'connected';
            _this.events.emit('ready');
        })));
    };
    Client.prototype.disconnect = function () {
        var _this = this;
        return rxjs_1.race(this.errorObservable, new rxjs_1.Observable(function (observer) {
            if (_this.status === 'disconnected') {
                observer.next();
                observer.complete();
                return;
            }
            _this.ftp.once('end', function () {
                _this.log('disconnected from ' + _this.config.host, 'debug');
                _this.status = 'disconnected';
                observer.next();
                observer.complete();
                _this.events.emit('end');
            });
            _this.ftp.end.call(_this.ftp);
        }));
    };
    /**
     * Remove a file from the remote path
     * @param  file    {
     *    src [string]: remote path to the file,
     * }
     * @param  newName [string] without the path (use baseDir)
     * @param  baseDir
     * @return
     */
    Client.prototype.renameRemoteFile = function (file, newName, baseDir) {
        var _this = this;
        if (baseDir === void 0) { baseDir = ''; }
        return rxjs_1.race(this.errorObservable, new rxjs_1.Observable(function (observer) {
            if (_this.status === 'disconnected') {
                observer.error(new Error('Not connected'));
                return;
            }
            var destPath = _this.cleanDestPath(file.src, baseDir);
            newName = path.join(baseDir, newName);
            _this.log('Renaming ' + destPath, 'debug');
            _this.ftp.rename.call(_this.ftp, destPath, newName, function (err) {
                if (!_this.testEmitError(err)) {
                    observer.next();
                }
                observer.complete();
            });
        }));
    };
    /**
     * Remove a file from the remote path
     * @param  file    {
     *    src [string]: remote path to the file,
     *    isDirectory [() => boolean]
     * }
     * @param  baseDir
     * @return
     */
    Client.prototype.deleteRemoteFile = function (file, baseDir) {
        var _this = this;
        if (baseDir === void 0) { baseDir = ''; }
        return rxjs_1.race(this.errorObservable, new rxjs_1.Observable(function (observer) {
            if (_this.status === 'disconnected') {
                observer.error(new Error('Not connected'));
                return;
            }
            var destPath = _this.cleanDestPath(file.src, baseDir);
            _this.log('Deleting ' + destPath, 'debug');
            if (file.isDirectory()) {
                _this.ftp.rmdir.call(_this.ftp, destPath, true, function (err) {
                    if (!_this.testEmitError(err)) {
                        observer.next();
                    }
                    observer.complete();
                });
            }
            else {
                _this.ftp.delete.call(_this.ftp, destPath, function (err) {
                    if (!_this.testEmitError(err)) {
                        observer.next();
                    }
                    observer.complete();
                });
            }
        }));
    };
    Client.prototype.deleteFiles = function (filesToDelete, baseDir) {
        var _this = this;
        if (baseDir === void 0) { baseDir = ''; }
        if (!filesToDelete || _.isEmpty(filesToDelete)) {
            this.log('No files to delete', 'debug');
            return rxjs_1.of(null);
        }
        return rxjs_1.iif(function () { return _this.status === 'disconnected'; }, rxjs_1.throwError(new Error('Not connected')), this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(filesToDelete, function (file) { return _this.deleteRemoteFile(file, baseDir); })).pipe(operators_1.mapTo(null)));
    };
    Client.prototype.deleteLocalFiles = function (filesToDelete) {
        var _this = this;
        if (!filesToDelete || _.isEmpty(filesToDelete)) {
            this.log('No files to delete', 'debug');
            return rxjs_1.of(null);
        }
        return this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(filesToDelete, function (file) { return rxjs_1.bindNodeCallback(fs.unlink).call(_this, file); })).pipe(operators_1.mapTo(null));
    };
    Client.prototype.generalUpload = function (dataToUpload, baseDir, fn, typeContent) {
        var _this = this;
        dataToUpload = _.compact(dataToUpload);
        if (!dataToUpload || _.isEmpty(dataToUpload)) {
            this.log("Nothing to upload", 'debug');
            return rxjs_1.of(null);
        }
        return rxjs_1.race(this.errorObservable, this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(dataToUpload, function (data) {
            return new rxjs_1.Observable(function (observer) {
                var _a;
                var destPath = _this.cleanDestPath(data.src, baseDir);
                try {
                    _this.log("Uploading " + typeContent + " (" + destPath + ")", 'debug');
                    var callArgs = void 0;
                    switch (fn) {
                        case 'mkdir':
                            callArgs = [destPath, true];
                            break;
                        default:
                            callArgs = [data.src, destPath];
                    }
                    (_a = _this.ftp[fn]).call.apply(_a, [_this.ftp].concat(callArgs, [function (err) {
                            var hasError = _this.testEmitError(err, "Error uploading " + typeContent + " (" + destPath + "): " + JSON.stringify(err), 'basic', function (error) { return _.assign(data, { error: error }); });
                            if (!hasError) {
                                _this.log("Finished upload " + typeContent + " (" + destPath + ")", 'basic');
                                _.assign(data, { uploaded: true });
                            }
                            observer.next(data);
                            observer.complete();
                        }]));
                }
                catch (err) {
                    _this.testEmitError(err, "Error uploading " + typeContent + " (" + destPath + "): " + JSON.stringify(err), 'basic', function (error) { return _.assign(data, { error: error }); });
                }
            });
        })));
    };
    Client.prototype.uploadFiles = function (filesToUpload, baseDir) {
        return this.generalUpload(filesToUpload, baseDir, 'put', 'file');
    };
    Client.prototype.uploadDirs = function (dirsToUpload, baseDir) {
        return this.generalUpload(dirsToUpload, baseDir, 'mkdir', 'directory');
    };
    Client.prototype.createLocalDirectories = function (dirs, baseDir, dest) {
        var _this = this;
        var out = [];
        dirs.forEach(function (dir) {
            var dirName = path.join(dest, _this.cleanDestPath(dir, baseDir));
            // `${dest}/${this.cleanDestPath(dir, baseDir)}`;
            out.push(_this.fileExist(dirName).pipe(operators_1.switchMap(function (exist) {
                if (!exist) {
                    return rxjs_1.bindNodeCallback(fs.mkdir)
                        .call(_this, dirName)
                        .pipe(operators_1.tap(function () { return _this.log('Created directory ' + dirName, 'debug'); }));
                }
                return rxjs_1.of(null);
            })));
        });
        return this.forkJoinLimit(this.MAX_CONNECTIONS, out).pipe(operators_1.mapTo(null));
    };
    /**
     * Returns the files to delete depending on the options passed (overwrite)
     * @param  files   files to compare with remote
     * @param  dirs    directories to compare with remote
     * @param  options
     */
    Client.prototype.getRemoteFilesToDelete = function (files, dirs, options) {
        var _this = this;
        var all = files.concat(dirs);
        if (options.overwrite === 'all') {
            return rxjs_1.of(all);
        }
        return rxjs_1.race(this.errorObservable, this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(all, function (file) {
            return new rxjs_1.Observable(function (observer) {
                var destPath = _this.cleanDestPath(file.src, options.baseDir);
                _this.ftp.list.call(_this.ftp, destPath, function (err, list) {
                    _this.testEmitError(err);
                    _this.log('Comparing file ' + file.src, 'debug');
                    if (list && list[0]) {
                        if (options.overwrite === 'older' &&
                            list[0].date &&
                            new Date(list[0].date.getTime() + _this.serverTimeDif) <
                                file.mtime) {
                            observer.next(file);
                            observer.complete();
                        }
                        else {
                            if (file.isDirectory()) {
                                dirs.forEach(function (dir, i) {
                                    if (dir.src === file.src) {
                                        dirs.splice(i, 1);
                                    }
                                });
                            }
                            else {
                                files.forEach(function (f, i) {
                                    if (file.src === f.src) {
                                        files.splice(i, 1);
                                    }
                                });
                            }
                        }
                    }
                    observer.next(null);
                    observer.complete();
                });
            });
        }))).pipe(operators_1.map(function (r) { return _.compact(r); }));
    };
    /**
     * Returns the files to delete depending on the options passed (overwrite)
     * @param  files   files to compare with local. The files existing and not
     * overwritten are skipped, and deleted from this object (they won't be
     * downloaded)
     * @param  options
     */
    Client.prototype.getLocalFilesToDelete = function (files, options, remotePath, localPath) {
        var _this = this;
        if (options.overwrite === 'all') {
            return rxjs_1.of(_.keys(files));
        }
        return rxjs_1.forkJoin(_.map(files, function (details, file) {
            var fileName = file.replace(remotePath, localPath);
            return _this.fileExist(fileName).pipe(operators_1.switchMap(function (exist) {
                if (exist) {
                    if (options.overwrite === 'older') {
                        return rxjs_1.bindNodeCallback(fs.stat)
                            .call(fs, fileName)
                            .pipe(operators_1.switchMap(function (stat) {
                            if (stat.mtime.getTime() <
                                details.date.getTime() + _this.serverTimeDif) {
                                return rxjs_1.of(fileName);
                            }
                            else {
                                _this.log('Skipping file', 'debug');
                                delete files[file];
                                return rxjs_1.of(null);
                            }
                        }));
                    }
                    _this.log('Skipping file', 'debug');
                    delete files[file];
                    return rxjs_1.of(null);
                }
                return rxjs_1.of(null);
            }));
        })).pipe(operators_1.map(function (r) { return _.compact(r); }));
    };
    Client.prototype.lookForRemoteContent = function (dir) {
        var _this = this;
        var dirs = [];
        var files = {};
        return rxjs_1.bindNodeCallback(this.ftp.list)
            .call(this.ftp, dir)
            .pipe(operators_1.tap(function () {
            _this.log("Looking for content in " + dir, 'debug');
        }), operators_1.catchError(function (err) {
            return rxjs_1.throwError(new Error('The source directory on the server ' +
                dir +
                ' does not exist. ' +
                err.message));
        }), operators_1.switchMap(function (list) {
            if (_.isUndefined(list) || _.isUndefined(list[0])) {
                return rxjs_1.throwError(new Error('The source directory on the server ' +
                    dir +
                    ' does not exist. '));
            }
            var out = [];
            _.each(list, function (file) {
                if (file.name !== '.' && file.name !== '..') {
                    _this.log('--- file ' + JSON.stringify(file));
                    var filename = path.join(dir, file.name);
                    // dir + '/' + file.name;
                    if (file.type === 'd') {
                        dirs.push(filename);
                        out.push(_this.lookForRemoteContent(filename));
                    }
                    else if (file.type === '-') {
                        files[filename] = {
                            date: file.date,
                        };
                    }
                }
            });
            if (out.length === 0) {
                return rxjs_1.of({ dirs: dirs, files: files });
            }
            return _this.forkJoinLimit(_this.MAX_CONNECTIONS, out).pipe(operators_1.map(function (results) {
                _.map(results, function (result) {
                    dirs = _.concat(dirs, result.dirs);
                    files = _.assign(files, result.files);
                });
                return { dirs: dirs, files: files };
            }));
        }));
    };
    Client.prototype.dowloadSingleFile = function (file, remotePath, localPath) {
        var _this = this;
        return new rxjs_1.Observable(function (observer) {
            _this.log('Downloading file ' + file, 'debug');
            _this.ftp.get.call(_this.ftp, file, function (err, stream) {
                if (err && err.message !== 'Unable to make data connection') {
                    _this.testEmitError(new Error('Error downloading file ' + file + ' - ' + JSON.stringify(err)), 'basic');
                    observer.error(err);
                }
                if (stream) {
                    stream.once('close', function () {
                        _this.log('Finished downloading file ' + file, 'basic');
                        observer.next(file);
                        observer.complete();
                    });
                    var writeStream = fs.createWriteStream(file.replace(remotePath, localPath));
                    writeStream.on('error', function (errw) {
                        observer.error(errw);
                        _this.testEmitError(errw);
                    });
                    stream.pipe(writeStream);
                }
                else {
                    observer.next(null);
                    observer.complete();
                }
            });
        });
    };
    Client.prototype.upload = function (patterns, dest, options) {
        var _this = this;
        options = _.defaults(options || {}, this.options);
        var optionsBk = this.options;
        this.options = options;
        var result = {
            uploadedFiles: [],
            uploadedDirs: [],
            errors: {},
        };
        // Fix for Windows slash
        if (options.baseDir) {
            options.baseDir = path.normalizeTrim(options.baseDir);
        }
        else {
            options.baseDir = '';
        }
        var paths = [];
        var files = [];
        var dirs = [];
        paths = this.glob(patterns, options.globOptions);
        paths = this.clean(paths, options.baseDir);
        paths = this.stat(paths);
        files = paths[1];
        dirs = paths[0];
        var sources = function (data) {
            var array = _.compact(_.clone(data));
            if (array.length === 0) {
                _this.log('-- None --', 'debug');
                return;
            }
            array.forEach(function (file) {
                _this.log(file.src, 'debug');
            });
        };
        var pushResults = function (datas, typeContent, resIndex) {
            if (!datas && _.isEmpty(datas)) {
                return;
            }
            _this.log('Uploaded ' + typeContent, 'debug');
            datas.forEach(function (data) {
                if (data.uploaded) {
                    result[resIndex].push(data.src);
                    _this.log(data.src, 'debug');
                }
                else {
                    result.errors[data.src] = data.error;
                    _this.log(data.error, 'debug', 'error');
                }
            });
        };
        this.log('FILES TO UPLOAD', 'debug');
        sources(files);
        this.log('DIRS TO UPLOAD', 'debug');
        sources(dirs);
        if (files.length === 0 && dirs.length === 0) {
            this.log('No files to upload');
            return rxjs_1.of(result);
        }
        return this.cwd(dest).pipe(operators_1.tap(function () { return _this.log('Moved to directory ' + dest, 'debug'); }), operators_1.switchMap(function () {
            _this.log('1. Compare files', 'debug');
            return _this.getRemoteFilesToDelete(files, dirs, options);
        }), operators_1.tap(function (toDelete) {
            _this.log('FILES TO DELETE', 'debug');
            sources(toDelete);
            _this.log('Found ' +
                files.length +
                ' files and ' +
                dirs.length +
                ' directories to upload.', 'basic');
        }), operators_1.switchMap(function (toDelete) {
            _this.log('2. Delete files', 'debug');
            return _this.deleteFiles(toDelete, options.baseDir);
        }), operators_1.switchMap(function () {
            _this.log('3. Upload dirs', 'debug');
            return _this.uploadDirs(dirs, options.baseDir);
        }), operators_1.tap(function (dirsToUpload) {
            pushResults(dirsToUpload, 'directories', 'uploadedDirs');
        }), operators_1.switchMap(function () {
            _this.log('4. Upload files', 'debug');
            return _this.uploadFiles(files, options.baseDir);
        }), operators_1.tap(function (filesToUpload) {
            pushResults(filesToUpload, 'files', 'uploadedFiles');
        }), operators_1.tap(function () {
            _this.log('Upload done', 'debug');
            _this.log('Finished uploading ' +
                result.uploadedFiles.length +
                ' of ' +
                files.length +
                ' files', 'basic');
        }), operators_1.mapTo(result), operators_1.concatMap(function (res) {
            return _this.endObservable(options, optionsBk).pipe(operators_1.mapTo(res));
        }), operators_1.catchError(function (err) {
            return _this.endObservable(options, optionsBk).pipe(operators_1.switchMapTo(rxjs_1.throwError(err)));
        }));
    };
    Client.prototype.download = function (source, dest, options) {
        var _this = this;
        options = _.defaults(options || {}, this.options);
        // All the operations inside with use the options passed, and after options
        // will be restored
        var optionsBk = this.options;
        this.options = options;
        var result = {
            downloadedFiles: [],
            errors: {},
        };
        var files = {};
        var dirs = [];
        return this.fileExist(dest).pipe(operators_1.switchMap(function (exist) {
            if (!exist) {
                return _this.disconnect().pipe(operators_1.switchMapTo(rxjs_1.throwError(new Error('The download destination directory ' +
                    dest +
                    ' does not exist.'))));
            }
            return rxjs_1.of(null);
        }), operators_1.switchMapTo(this.lookForRemoteContent(source)), operators_1.tap(function (data) {
            files = data.files;
            dirs = data.dirs;
            _this.log('FILES TO DOWNLOAD', 'debug');
            _this.log(JSON.stringify(files), 'debug');
            _this.log('DIRS TO DOWNLOAD', 'debug');
            _this.log(dirs, 'debug');
        }), operators_1.switchMap(function () {
            _this.log('1. Creating local directories', 'debug');
            return _this.createLocalDirectories(dirs, source, dest);
        }), operators_1.switchMap(function () {
            _this.log('2. Compare files', 'debug');
            return _this.getLocalFilesToDelete(files, options, source, dest);
        }), operators_1.tap(function (toDelete) {
            _this.log('FILES TO DELETE', 'debug');
            _this.log(toDelete, 'debug');
        }), operators_1.switchMap(function (toDelete) {
            _this.log('3. Delete files', 'debug');
            return _this.deleteLocalFiles(toDelete);
        }), operators_1.tap(function () {
            _this.log('Found ' + _.keys(files).length + ' files to download.', 'basic');
        }), operators_1.switchMap(function () {
            _this.log('4. Download files', 'debug');
            return _this.forkJoinLimit(_this.MAX_CONNECTIONS, _.map(_.keys(files), function (file) {
                return _this.dowloadSingleFile(file, source, dest).pipe(operators_1.tap(function (fileDownloaded) {
                    if (fileDownloaded) {
                        result.downloadedFiles.push(fileDownloaded);
                    }
                }), operators_1.catchError(function (err) {
                    result.errors[file] = err;
                    return rxjs_1.of(null);
                }));
            }));
        }), operators_1.tap(function () {
            _this.log('Finished downloading ' +
                result.downloadedFiles.length +
                ' of ' +
                _.keys(files).length +
                ' files', 'basic');
        }), operators_1.mapTo(result), operators_1.concatMap(function (res) { return _this.endObservable(options, optionsBk).pipe(operators_1.mapTo(res)); }), operators_1.catchError(function (err) {
            return _this.endObservable(options, optionsBk).pipe(operators_1.switchMapTo(rxjs_1.throwError(err)));
        }));
    };
    return Client;
}());
exports.Client = Client;
