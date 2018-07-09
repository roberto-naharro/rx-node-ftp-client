/// <reference types="rxjs" />
/// <reference types="node" />
declare module 'rx-node-ftp-client' {
	/// <reference types="node" />
	import * as fs from 'fs';
	import { EventEmitter } from 'events';
	import * as FTP from 'ftp';
	import { Observable } from 'rxjs';
	export type LoggingLevels = 'none' | 'basic' | 'debug';
	export type LoggingTypes = 'info' | 'error' | 'log' | 'warn' | 'trace';
	export interface Options {
	    overwrite?: 'older' | 'all' | 'none';
	    testingTimezoneDir?: string;
	    globOptions?: {
	        nonull: false;
	    };
	    logging?: LoggingLevels;
	    logger?: any;
	    baseDir?: string;
	    disconnect?: boolean;
	}
	export interface UploadResults {
	    uploadedFiles: string[];
	    uploadedDirs: string[];
	    errors: {
	        [origin: string]: Error;
	    };
	}
	export interface DownloadResults {
	    downloadedFiles: string[];
	    errors: {
	        [origin: string]: Error;
	    };
	}
	export interface CustomStats extends fs.Stats {
	    src: string;
	    uploaded?: boolean;
	    error?: Error;
	}
	export interface RemoteDirFiles {
	    [filename: string]: {
	        date: Date;
	    };
	}
	export interface RemoteDirContent {
	    dirs: string[];
	    files: RemoteDirFiles;
	}
	export class Client {
	    private config;
	    private options;
	    readonly MAX_CONNECTIONS: number;
	    status: 'connected' | 'disconnected';
	    ftp: FTP;
	    serverTimeDif: number;
	    errorObservable: Observable<never>;
	    events: EventEmitter;
	    constructor(config?: FTP.Options, options?: Options);
	    private log;
	    /**
	     * Emit the error, return the output of the callback function or true if there
	     * is any error or false if there isn't
	     * @param  err Error
	     */
	    private testEmitError;
	    private fileExist;
	    private checkTimezone;
	    private glob;
	    private clean;
	    private stat;
	    private cwd;
	    private cleanDestPath;
	    private forkJoinLimit;
	    private endObservable;
	    setConfig(config?: FTP.Options, options?: Options): void;
	    connect(): Observable<void>;
	    disconnect(): Observable<void>;
	    /**
	     * Remove a file from the remote path
	     * @param  file    {
	     *    src [string]: remote path to the file,
	     * }
	     * @param  newName [string] without the path (use baseDir)
	     * @param  baseDir
	     * @return
	     */
	    renameRemoteFile(file: CustomStats, newName: string, baseDir?: string): Observable<void>;
	    /**
	     * Remove a file from the remote path
	     * @param  file    {
	     *    src [string]: remote path to the file,
	     *    isDirectory [() => boolean]
	     * }
	     * @param  baseDir
	     * @return
	     */
	    deleteRemoteFile(file: CustomStats, baseDir?: string): Observable<void>;
	    deleteFiles(filesToDelete: CustomStats[], baseDir?: string): Observable<void>;
	    deleteLocalFiles(filesToDelete: string[]): Observable<void>;
	    generalUpload(dataToUpload: CustomStats[], baseDir: string, fn: string, typeContent: string): Observable<CustomStats[]>;
	    uploadFiles(filesToUpload: CustomStats[], baseDir: string): Observable<CustomStats[]>;
	    uploadDirs(dirsToUpload: CustomStats[], baseDir: string): Observable<CustomStats[]>;
	    createLocalDirectories(dirs: string[], baseDir: string, dest: string): Observable<void>;
	    /**
	     * Returns the files to delete depending on the options passed (overwrite)
	     * @param  files   files to compare with remote
	     * @param  dirs    directories to compare with remote
	     * @param  options
	     */
	    getRemoteFilesToDelete(files: CustomStats[], dirs: CustomStats[], options: Options): Observable<CustomStats[]>;
	    /**
	     * Returns the files to delete depending on the options passed (overwrite)
	     * @param  files   files to compare with local. The files existing and not
	     * overwritten are skipped, and deleted from this object (they won't be
	     * downloaded)
	     * @param  options
	     */
	    getLocalFilesToDelete(files: RemoteDirFiles, options: Options, remotePath: string, localPath: string): Observable<string[]>;
	    lookForRemoteContent(dir: string): Observable<RemoteDirContent>;
	    dowloadSingleFile(file: string, remotePath: string, localPath: string): Observable<string>;
	    upload(patterns: string | string[], dest: string, options?: Options): Observable<UploadResults>;
	    download(source: string, dest: string, options?: Options): Observable<DownloadResults>;
	}

}
