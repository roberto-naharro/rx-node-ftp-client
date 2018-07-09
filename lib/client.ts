import * as fs from 'fs';
import * as path from 'upath';
import { EventEmitter } from 'events';
import * as FTP from 'ftp';
import * as _ from 'lodash';
import * as glob from 'glob';
import {
  Observable, bindNodeCallback, of, ObservableInput, forkJoin, throwError,
  race, iif,
} from 'rxjs';
import {
  tap, switchMap, switchMapTo, catchError, map, concatMap, mapTo,
  first,
} from 'rxjs/operators';

export type LoggingLevels = 'none' | 'basic' | 'debug';
export type LoggingTypes = 'info' | 'error' | 'log' | 'warn' | 'trace';
const loggingLevels: LoggingLevels[] = ['none', 'basic', 'debug'];

export interface Options {
  overwrite?: 'older' | 'all' | 'none',
  testingTimezoneDir?: string,
  globOptions?: {
    nonull: false,
  },
  logging?: LoggingLevels,
  logger?: any,
  baseDir?: string,
  disconnect?: boolean,
}

export interface UploadResults {
  uploadedFiles: string[],
  uploadedDirs: string[],
  errors: {
    [origin: string]: Error,
  },
}

export interface DownloadResults {
  downloadedFiles: string[],
  errors: {
    [origin: string]: Error,
  },
}

export interface CustomStats extends fs.Stats {
  src: string,
  uploaded?: boolean,
  error?: Error,
}

export interface RemoteDirFiles {
  [filename: string]: { date: Date },
}

export interface RemoteDirContent {
  dirs: string[],
  files: RemoteDirFiles,
}

export class Client {
  private config: FTP.Options = {
    host: 'localhost',
    port: 21,
    user: 'anonymous',
    password: 'anonymous@',
  };
  private options: Options = {
    overwrite: 'older',
    testingTimezoneDir: null,
    globOptions: {
      nonull: false,
    },
    logging: 'basic' as LoggingLevels,
    logger: console,
    disconnect: true,
  };
  readonly MAX_CONNECTIONS = 10;
  status: 'connected' | 'disconnected' = 'disconnected';
  ftp: FTP;
  serverTimeDif: number;
  errorObservable: Observable<never>;
  events = new EventEmitter();

  constructor(config?: FTP.Options, options?: Options) {
    this.setConfig(config, options);

    this.ftp = new FTP();
    this.errorObservable = new Observable(observer => {
      this.ftp.removeAllListeners('error');
      this.ftp.on('error', (err: Error) => {
        this.testEmitError(err, 'Error - ' + JSON.stringify(err), 'basic');

        // XXX Check if throwing the error stops everything
        observer.error(err);
      });
    });
  }

  private log(msg: any, lvl: LoggingLevels = 'basic',
    type: LoggingTypes = 'info'): void {
    if (loggingLevels.indexOf(lvl) <=
      loggingLevels.indexOf(this.options.logging)) {
      this.options.logger[type](msg);
    }
  }

  /**
   * Emit the error, return the output of the callback function or true if there
   * is any error or false if there isn't
   * @param  err Error
   */
  private testEmitError<T>(err: Error, msg?: string,
    lvl: LoggingLevels = 'debug', callback?: (err?: Error) => T): T | boolean {
    if (err) {
      this.events.emit('error', err);
      this.log(msg ? msg : err, lvl, 'error');
      if (callback) {
        const out = callback(err);
        if (out) {
          return out;
        }
      }
      return true;
    }
    return false;
  }

  private fileExist(path: string): Observable<boolean> {
    return bindNodeCallback<string>(
      (dir: string, callBack: (err: any, res?: boolean) => boolean) => {
        fs.access(dir, fs.constants.F_OK, (err) => {
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
  }

  private checkTimezone(): Observable<void> {
    const localTime = new Date().getTime();
    let serverTime;
    let timestampPath = '.timestamp';
    timestampPath = this.options.testingTimezoneDir ?
      path.join(this.options.testingTimezoneDir, timestampPath) : timestampPath;
    const manageError = (err) => this.testEmitError(err, 'Error - ' +
      JSON.stringify(err), 'debug', () => of(null)) as Observable<void>;
    return race(
      this.errorObservable,
      of(null).pipe(
        switchMapTo(
          bindNodeCallback(this.ftp.put)
            .call(this.ftp, new Buffer('blank'), timestampPath).pipe(
              catchError(err => {
                return manageError(err);
              }),
          )),
        switchMapTo(
          bindNodeCallback(this.ftp.list)
            .call(this.ftp, timestampPath).pipe(
              catchError(err => {
                return manageError(err);
              }),
              tap(list => {
                if (list && list[0] && list[0].date) {
                  serverTime = list[0].date.getTime();
                }
              }),
          )),
        switchMapTo<void>(
          bindNodeCallback(this.ftp.delete)
            .call(this.ftp, timestampPath).pipe(
              catchError(err => {
                return manageError(err);
              }),
          )),
        tap(() => {
          this.serverTimeDif = localTime - serverTime;
          this.log('Server time is ' +
            new Date(new Date().getTime() -
              this.serverTimeDif), 'debug');
        }),
        first(),
      ));
  }

  private glob(patterns: string | string[], options): string[] {
    options = _.defaults(options || {}, this.options.globOptions);
    let include: string[] = [];
    let exclude: string[] = [];

    if (!_.isArray(patterns)) {
      patterns = [patterns];
    }

    patterns.forEach(function(pattern) {
      if (pattern.indexOf('!') === 0) {
        exclude = exclude.concat(
          glob.sync(pattern.substring(1), options) || []);
      } else {
        include = include.concat(glob.sync(pattern, options) || []);
      }
    });

    return _.difference(include, exclude);
  }

  private clean(files: string[], baseDir: string): string[] {
    if (!baseDir) {
      return files;
    }

    return _.compact(_.map(files, file => {
      if (file.replace(baseDir, '')) {
        return file;
      } else {
        return null;
      }
    }));
  }

  private stat(files: string[]): CustomStats[][] {
    const result: CustomStats[][] = [[], []];
    _.each(files, f => {
      const file: CustomStats = _.extend(fs.statSync(f), {
        src: f,
      });
      if (file.isDirectory()) {
        result[0].push(file);
      } else {
        result[1].push(file);
      }
    });
    return result;
  }

  private cwd(pathRemote: string): Observable<void> {
    return race(
      this.errorObservable,
      new Observable(observer => {
        this.ftp.mkdir.call(this.ftp, pathRemote, true, err1 => {
          this.testEmitError(err1);
          this.ftp.cwd.call(this.ftp, pathRemote, err2 => {
            this.testEmitError(err2);
            observer.next();
            observer.complete();
          });
        });
      }));
  }

  private cleanDestPath(pathIn: string, baseDir: string): string {
    pathIn = path.normalizeTrim(pathIn);
    baseDir = path.normalizeTrim(baseDir);
    return pathIn.indexOf(baseDir) === 0 ?
      pathIn.substring(baseDir.length + 1) : pathIn;
  }

  private forkJoinLimit<T>(limit: number,
    sources: Array<ObservableInput<T>>): Observable<T[]> {
    if (sources.length < limit) {
      return forkJoin(sources);
    }
    return _.reduce(_.chunk(sources, limit), (acc, subSource) => {
      acc = acc.pipe(
        concatMap(val =>
          forkJoin(subSource).pipe(
            map(val2 => (val) ? _.concat(val, val2) : val2),
          )));
      return acc;
    }, of(null));
  }

  private endObservable(options, optionsBk) {
    return iif(
      () => options.disconnect,
      this.disconnect(),
      of(null),
    ).pipe(
      tap(() => this.options = optionsBk),
    );
  }

  setConfig(config?: FTP.Options, options?: Options) {
    if (this.status === 'connected') {
      throw new Error('You cannot change the config while you are connected');
    }
    this.config = _.defaults(config || {}, this.config);
    this.options = _.defaults(options || {}, this.options);
  }

  connect(): Observable<void> {
    return race(
      this.errorObservable,
      new Observable<void>(observer => {
        this.ftp.once('ready', () => {
          this.log('Connected to ' + this.config.host, 'debug');
          this.log('Checking server local time...', 'debug');
          observer.next();
          observer.complete();
        });
        this.ftp.connect.call(this.ftp, this.config);
      }).pipe(
        switchMapTo(this.checkTimezone()),
        tap(() => {
          this.status = 'connected';
          this.events.emit('ready');
        }),
      ));
  }

  disconnect(): Observable<void> {
    return race(
      this.errorObservable,
      new Observable<void>(observer => {
        if (this.status === 'disconnected') {
          observer.next();
          observer.complete();
          return;
        }
        this.ftp.once('end', () => {
          this.log('disconnected from ' + this.config.host, 'debug');
          this.status = 'disconnected';
          observer.next();
          observer.complete();
          this.events.emit('end');
        });
        this.ftp.end.call(this.ftp);
      }));
  }

  /**
   * Remove a file from the remote path
   * @param  file    {
   *    src [string]: remote path to the file,
   * }
   * @param  newName [string] without the path (use baseDir)
   * @param  baseDir
   * @return
   */
  renameRemoteFile(file: CustomStats, newName: string, baseDir: string = ''):
    Observable<void> {
    return race(
      this.errorObservable,
      new Observable<void>(observer => {
        if (this.status === 'disconnected') {
          observer.error(new Error('Not connected'));
          return;
        }
        const destPath = this.cleanDestPath(file.src, baseDir);
        newName = path.join(baseDir, newName);

        this.log('Renaming ' + destPath, 'debug');
        this.ftp.rename.call(this.ftp, destPath, newName, err => {
          if (!this.testEmitError(err)) {
            observer.next();
          }
          observer.complete();
        });
      }));
  }

  /**
   * Remove a file from the remote path
   * @param  file    {
   *    src [string]: remote path to the file,
   *    isDirectory [() => boolean]
   * }
   * @param  baseDir
   * @return
   */
  deleteRemoteFile(file: CustomStats, baseDir: string = ''): Observable<void> {
    return race(
      this.errorObservable,
      new Observable<void>(observer => {
        if (this.status === 'disconnected') {
          observer.error(new Error('Not connected'));
          return;
        }
        const destPath = this.cleanDestPath(file.src, baseDir);

        this.log('Deleting ' + destPath, 'debug');

        if (file.isDirectory()) {
          this.ftp.rmdir.call(this.ftp, destPath, true, err => {
            if (!this.testEmitError(err)) {
              observer.next();
            }
            observer.complete();
          });
        }
        else {
          this.ftp.delete.call(this.ftp, destPath, err => {
            if (!this.testEmitError(err)) {
              observer.next();
            }
            observer.complete();
          });
        }
      }));
  }

  deleteFiles(filesToDelete: CustomStats[], baseDir: string = ''):
    Observable<void> {
    if (!filesToDelete || _.isEmpty(filesToDelete)) {
      this.log('No files to delete', 'debug');
      return of(null);
    }
    return iif(
      () => this.status === 'disconnected',
      throwError(new Error('Not connected')),
      this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(filesToDelete, file =>
        this.deleteRemoteFile(file, baseDir))).pipe(
          mapTo(null),
      ));
  }

  deleteLocalFiles(filesToDelete: string[]): Observable<void> {
    if (!filesToDelete || _.isEmpty(filesToDelete)) {
      this.log('No files to delete', 'debug');
      return of(null);
    }

    return this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(filesToDelete, file =>
      bindNodeCallback(fs.unlink).call(this, file))).pipe(
        mapTo(null),
    );
  }

  generalUpload(dataToUpload: CustomStats[], baseDir: string,
    fn: string, typeContent: string):
    Observable<CustomStats[]> {
    dataToUpload = _.compact(dataToUpload);
    if (!dataToUpload || _.isEmpty(dataToUpload)) {
      this.log(`Nothing to upload`, 'debug');
      return of(null);
    }
    return race(
      this.errorObservable,
      this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(dataToUpload, data =>
        new Observable<CustomStats>(observer => {
          const destPath = this.cleanDestPath(data.src, baseDir);
          try {
            this.log(`Uploading ${typeContent} (${destPath})`, 'debug');
            let callArgs;
            switch (fn) {
              case 'mkdir':
                callArgs = [destPath, true];
                break;
              default:
                callArgs = [data.src, destPath];
            }
            this.ftp[fn].call(this.ftp, ...callArgs, err => {
              const hasError = this.testEmitError(err,
                `Error uploading ${typeContent} (${destPath}): ${
                JSON.stringify(err)}`, 'basic',
                (error) => _.assign(data, { error }),
              );
              if (!hasError) {
                this.log(`Finished upload ${typeContent} (${destPath})`,
                  'basic');
                _.assign(data, { uploaded: true });
              }
              observer.next(data);
              observer.complete();
            });

          } catch (err) {
            this.testEmitError(err,
              `Error uploading ${typeContent} (${destPath}): ${
              JSON.stringify(err)}`, 'basic',
              (error) => _.assign(data, { error }),
            );
          }
        }))));
  }

  uploadFiles(filesToUpload: CustomStats[], baseDir: string):
    Observable<CustomStats[]> {
    return this.generalUpload(filesToUpload, baseDir, 'put', 'file');
  }

  uploadDirs(dirsToUpload: CustomStats[], baseDir: string):
    Observable<CustomStats[]> {
    return this.generalUpload(dirsToUpload, baseDir, 'mkdir', 'directory');
  }

  createLocalDirectories(dirs: string[], baseDir: string, dest: string):
    Observable<void> {
    const out = [];

    dirs.forEach(dir => {
      const dirName = path.join(dest, this.cleanDestPath(dir, baseDir));
      // `${dest}/${this.cleanDestPath(dir, baseDir)}`;
      out.push(this.fileExist(dirName).pipe(
        switchMap(exist => {
          if (!exist) {
            return bindNodeCallback(fs.mkdir).call(this, dirName).pipe(
              tap(() => this.log('Created directory ' + dirName, 'debug')),
            );
          }
          return of(null);
        }),
      ));
    });
    return this.forkJoinLimit(this.MAX_CONNECTIONS, out).pipe(mapTo(null));
  }

  /**
   * Returns the files to delete depending on the options passed (overwrite)
   * @param  files   files to compare with remote
   * @param  dirs    directories to compare with remote
   * @param  options
   */
  getRemoteFilesToDelete(files: CustomStats[], dirs: CustomStats[],
    options: Options): Observable<CustomStats[]> {
    const all: CustomStats[] = files.concat(dirs);
    if (options.overwrite === 'all') {
      return of(all);
    }
    return race(
      this.errorObservable,
      this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(all, file =>
        new Observable<CustomStats>(observer => {
          const destPath = this.cleanDestPath(file.src, options.baseDir);

          this.ftp.list.call(this.ftp, destPath, (err, list) => {
            this.testEmitError(err);
            this.log('Comparing file ' + file.src, 'debug');
            if (list && list[0]) {
              if (options.overwrite === 'older' && list[0].date &&
                new Date(list[0].date.getTime() + this.serverTimeDif)
                < file.mtime) {
                observer.next(file);
                observer.complete();
              } else {
                if (file.isDirectory()) {
                  dirs.forEach((dir, i) => {
                    if (dir.src === file.src) {
                      dirs.splice(i, 1);
                    }
                  });
                } else {
                  files.forEach((f, i) => {
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
        })))).pipe(
          map(r => _.compact(r)),
    );
  }

  /**
   * Returns the files to delete depending on the options passed (overwrite)
   * @param  files   files to compare with local. The files existing and not
   * overwritten are skipped, and deleted from this object (they won't be
   * downloaded)
   * @param  options
   */
  getLocalFilesToDelete(files: RemoteDirFiles, options: Options,
    remotePath: string, localPath: string): Observable<string[]> {
    if (options.overwrite === 'all') {
      return of(_.keys(files));
    }
    return forkJoin(_.map(files, (details, file) => {
      const fileName = file.replace(remotePath, localPath);
      return this.fileExist(fileName).pipe(
        switchMap(exist => {
          if (exist) {
            if (options.overwrite === 'older') {
              return bindNodeCallback(fs.stat).call(fs, fileName).pipe(
                switchMap((stat: fs.Stats) => {
                  if (stat.mtime.getTime() < details.date.getTime() +
                    this.serverTimeDif) {
                    return of(fileName);
                  } else {
                    this.log('Skipping file', 'debug');
                    delete files[file];
                    return of(null);
                  }
                }),
              );
            }
            this.log('Skipping file', 'debug');
            delete files[file];
            return of(null);
          }
          return of(null);
        }),
      );
    })).pipe(
      map(r => _.compact(r)),
    );
  }

  lookForRemoteContent(dir: string): Observable<RemoteDirContent> {
    let dirs = [];
    let files = {};
    return bindNodeCallback(this.ftp.list).call(this.ftp, dir).pipe(
      tap(() => {
        this.log(`Looking for content in ${dir}`, 'debug');
      }),
      catchError((err: Error) => {
        return throwError(new Error('The source directory on the server '
          + dir + ' does not exist. ' + err.message));
      }),
      switchMap(list => {
        if (_.isUndefined(list) || _.isUndefined(list[0])) {
          return throwError(new Error('The source directory on the server '
            + dir + ' does not exist. '));
        }
        const out: Array<Observable<RemoteDirContent>> = [];

        _.each(list, (file: FTP.ListingElement) => {
          if (file.name !== '.' && file.name !== '..') {
            this.log('--- file ' + JSON.stringify(file));
            const filename = path.join(dir, file.name);
            // dir + '/' + file.name;
            if (file.type === 'd') {
              dirs.push(filename);
              out.push(this.lookForRemoteContent(filename));
            } else if (file.type === '-') {
              files[filename] = {
                date: file.date,
              };
            }
          }
        });

        if (out.length === 0) {
          return of({ dirs, files });
        }
        return this.forkJoinLimit(this.MAX_CONNECTIONS, out).pipe(
          map(results => {
            _.map(results, result => {
              dirs = _.concat(dirs, result.dirs);
              files = _.assign(files, result.files);
            });
            return { dirs, files };
          }),
        );
      }),
    );
  }

  dowloadSingleFile(file: string, remotePath: string, localPath: string):
    Observable<string> {
    return new Observable<string>(observer => {
      this.log('Downloading file ' + file, 'debug');

      this.ftp.get.call(this.ftp, file, (err, stream) => {
        if (err && err.message !== 'Unable to make data connection') {
          this.testEmitError(new Error('Error downloading file ' + file + ' - '
            + JSON.stringify(err)),
            'basic');
          observer.error(err);
        }
        if (stream) {
          stream.once('close', () => {
            this.log('Finished downloading file ' + file, 'basic');
            observer.next(file);
            observer.complete();
          });
          const writeStream = fs.createWriteStream(file.replace(remotePath,
            localPath));
          writeStream.on('error', errw => {
            observer.error(errw);
            this.testEmitError(errw);
          });
          stream.pipe(writeStream);
        }
        else {
          observer.next(null);
          observer.complete();
        }
      });

    });
  }

  upload(patterns: string | string[], dest: string,
    options?: Options): Observable<UploadResults> {
    options = _.defaults(options || {}, this.options);
    const optionsBk = this.options;
    this.options = options;
    const result = {
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

    let paths = [];
    let files = [];
    let dirs = [];

    paths = this.glob(patterns, options.globOptions);
    paths = this.clean(paths, options.baseDir);
    paths = this.stat(paths);

    files = paths[1];
    dirs = paths[0];

    const sources = (data: CustomStats[]) => {
      const array = _.compact(_.clone(data));
      if (array.length === 0) {
        this.log('-- None --', 'debug');
        return;
      }
      array.forEach(file => {
        this.log(file.src, 'debug');
      });
    };

    const pushResults = (datas: CustomStats[], typeContent: string,
      resIndex: string): void => {
      if (!datas && _.isEmpty(datas)) {
        return;
      }
      this.log('Uploaded ' + typeContent, 'debug');
      datas.forEach(data => {
        if (data.uploaded) {
          result[resIndex].push(data.src);
          this.log(data.src, 'debug');
        } else {
          result.errors[data.src] = data.error;
          this.log(data.error, 'debug', 'error');
        }
      });
    };

    this.log('FILES TO UPLOAD', 'debug');
    sources(files);

    this.log('DIRS TO UPLOAD', 'debug');
    sources(dirs);

    if (files.length === 0 && dirs.length === 0) {
      this.log('No files to upload');
      return of(result);
    }

    return this.cwd(dest).pipe(
      tap(() => this.log('Moved to directory ' + dest, 'debug')),
      switchMap(() => {
        this.log('1. Compare files', 'debug');
        return this.getRemoteFilesToDelete(files, dirs, options);
      }),
      tap(toDelete => {
        this.log('FILES TO DELETE', 'debug');
        sources(toDelete);
        this.log('Found ' + files.length + ' files and ' + dirs.length +
          ' directories to upload.', 'basic');
      }),
      switchMap((toDelete) => {
        this.log('2. Delete files', 'debug');
        return this.deleteFiles(toDelete, options.baseDir);
      }),
      switchMap(() => {
        this.log('3. Upload dirs', 'debug');
        return this.uploadDirs(dirs, options.baseDir);
      }),
      tap(dirsToUpload => {
        pushResults(dirsToUpload, 'directories', 'uploadedDirs');
      }),
      switchMap(() => {
        this.log('4. Upload files', 'debug');
        return this.uploadFiles(files, options.baseDir);
      }),
      tap(filesToUpload => {
        pushResults(filesToUpload, 'files', 'uploadedFiles');
      }),
      tap(() => {
        this.log('Upload done', 'debug');
        this.log('Finished uploading ' + result.uploadedFiles.length + ' of ' +
          files.length + ' files', 'basic');
      }),
      mapTo(result),
      concatMap(res =>
        this.endObservable(options, optionsBk).pipe(
          mapTo(res),
        )),
      catchError((err) => {
        return this.endObservable(options, optionsBk).pipe(
          switchMapTo(throwError(err)),
        );
      }),
    );
  }

  download(source: string, dest: string, options?: Options):
    Observable<DownloadResults> {
    options = _.defaults(options || {}, this.options);
    // All the operations inside with use the options passed, and after options
    // will be restored
    const optionsBk = this.options;
    this.options = options;
    const result: DownloadResults = {
      downloadedFiles: [],
      errors: {},
    };

    let files = {};
    let dirs: string[] = [];

    return this.fileExist(dest).pipe(
      switchMap(exist => {
        if (!exist) {
          return this.disconnect().pipe(
            switchMapTo(throwError(
              new Error('The download destination directory '
                + dest + ' does not exist.'))),
          );
        }
        return of(null);
      }),
      switchMapTo(this.lookForRemoteContent(source)),
      tap<RemoteDirContent>(data => {
        files = data.files;
        dirs = data.dirs;
        this.log('FILES TO DOWNLOAD', 'debug');
        this.log(JSON.stringify(files), 'debug');

        this.log('DIRS TO DOWNLOAD', 'debug');
        this.log(dirs, 'debug');
      }),
      switchMap(() => {
        this.log('1. Creating local directories', 'debug');
        return this.createLocalDirectories(dirs, source, dest);
      }),
      switchMap(() => {
        this.log('2. Compare files', 'debug');
        return this.getLocalFilesToDelete(files, options, source, dest);
      }),
      tap(toDelete => {
        this.log('FILES TO DELETE', 'debug');
        this.log(toDelete, 'debug');
      }),
      switchMap(toDelete => {
        this.log('3. Delete files', 'debug');
        return this.deleteLocalFiles(toDelete);
      }),
      tap(() => {
        this.log('Found ' + _.keys(files).length + ' files to download.',
          'basic');
      }),
      switchMap(() => {
        this.log('4. Download files', 'debug');
        return this.forkJoinLimit(this.MAX_CONNECTIONS, _.map(_.keys(files),
          file => this.dowloadSingleFile(file, source, dest).pipe(
            tap(fileDownloaded => {
              if (fileDownloaded) {
                result.downloadedFiles.push(fileDownloaded);
              }
            }),
            catchError(err => {
              result.errors[file] = err;
              return of(null);
            }),
          )));
      }),
      tap(() => {
        this.log('Finished downloading ' + result.downloadedFiles.length +
          ' of ' + _.keys(files).length + ' files', 'basic');
      }),
      mapTo(result),
      concatMap(res => this.endObservable(options, optionsBk).pipe(
        mapTo(res),
      )),
      catchError((err) => {
        return this.endObservable(options, optionsBk).pipe(
          switchMapTo(throwError(err)),
        );
      }),
    );
  }
}
