import 'mocha';
import * as fs from 'fs';
// import * as sinon from 'sinon';
// import * as faker from 'faker';
import { expect, file } from './chai-importer.test';
import * as _ from 'lodash';
import * as path from 'upath';
import { bindNodeCallback, of, throwError } from 'rxjs';
import {
  switchMapTo, tap, concat, catchError, mapTo,
  ignoreElements,
} from 'rxjs/operators';
import * as rimraf from 'rimraf';

import { Client, Options } from '../lib/client';

let ftpClient: Client;

const serverFTPTest = {
  host: 'ftp.dlptest.com',
  port: 21,
  user: 'dlpuser@dlptest.com',
  password: '3D6XZV9MKdhM5fF',
  debug: (msg) => {
    // console.log('\t\tFTP --> ' + msg);
  },
};

const options: Options = {
  logging: 'debug',
};

ftpClient = new Client(serverFTPTest, options);

describe('Test connection', function() {
  it(`connect to the test server`, function(done) {
    let connected = false;
    ftpClient.connect().subscribe(
      () => connected = true,
      err => done(err),
      () => {
        expect(connected).to.be.true;
        expect(ftpClient.status).to.be.equal('connected');
        done();
      },
    );
  });

  it(`disconnect from the test server`, function(done) {
    let connected = true;
    ftpClient.disconnect().subscribe(
      () => connected = false,
      err => done(err),
      () => {
        expect(connected).to.be.false;
        expect(ftpClient.status).to.be.equal('disconnected');
        done();
      },
    );
  });
});

describe('Test upload', function() {
  const testFiles = [
    './test.txt',
    './dir',
    './dir/*',
  ];
  const remotePath = '/test';
  beforeEach(function(done) {
    this.timeout(0);
    ftpClient.connect().subscribe({
      error: err => done(err),
      complete: () => done(),
    });
  });
  afterEach(function(done) {
    this.timeout(0);
    ftpClient.connect().pipe(
      switchMapTo(
        ftpClient.deleteRemoteFile({
          src: remotePath,
          isDirectory: () => true,
        } as any)),
      switchMapTo(
        ftpClient.disconnect()),
    ).subscribe({
      error: err => done(err),
      complete: () => done(),
    });
  });

  it(`upload one file to the test server`, function(done) {
    ftpClient.upload(path.join(__dirname, testFiles[0]),
      remotePath, { baseDir: __dirname }).subscribe(
        results => {
          expect(results, 'No results returned').to.exist;
          expect(results.uploadedFiles).to.be.eql([
            path.join(__dirname, testFiles[0]),
          ]);
          expect(results.uploadedDirs).to.be.empty;
          expect(results.errors, 'Errors detected').to.be.empty;
        },
        err => done(err),
        () => {
          expect(ftpClient.status).to.be.equal('disconnected');
          done();
        },
    );
  }).timeout(20000);

  it(`upload multiple files to the test server`, function(done) {
    ftpClient.upload(_.map(testFiles, t => path.join(__dirname, t)),
      remotePath, { baseDir: __dirname }).subscribe(
        results => {
          expect(results, 'No results returned').to.exist;
          expect(results.uploadedFiles).to.be.length(3);
          expect(results.uploadedDirs).to.be.length(1);
          expect(results.errors, 'Errors detected').to.be.empty;
        },
        err => done(err),
        () => {
          expect(ftpClient.status).to.be.equal('disconnected');
          done();
        },
    );
  }).timeout(20000);
});

describe.only('Test download', function() {
  const testFiles = [
    './test.txt',
    './dir',
    './dir/*',
  ];
  const remotePath: string = '/test';
  const downloadPath: string = '/download';

  beforeEach(function(done) {
    this.timeout(0);
    ftpClient.setConfig(
      serverFTPTest,
      _.assign(_.clone(options), {
        logging: 'none',
        baseDir: __dirname,
      }),
    );
    ftpClient.connect().pipe(
      tap(() => console.info('Before - Uploading test files')),
      switchMapTo(
        ftpClient.upload(_.map(testFiles, t => path.join(__dirname, t)),
          remotePath)),
      tap(() => console.info('Before - Files uploaded, creating folder '
        + downloadPath)),
      switchMapTo(
        bindNodeCallback(fs.mkdir).call(this,
          path.join(__dirname, downloadPath)).pipe(
            catchError(err => {
              if (err.code === 'EEXIST') {
                return of(null);
              }
              return throwError(err);
            }),
          )),
      tap(() => console.info('Before - Done')),
      tap(() => {
        console.info('Before - Set new config'),
          ftpClient.setConfig(
            _.assign(_.clone(serverFTPTest), {
              logging: 'debug',
              debug: (msg) => {
                // console.log('\t\tFTP --> ' + msg);
              },
            }),
            _.assign(_.clone(options), {}),
          );
      }),
      switchMapTo(ftpClient.connect()),
      catchError((err) => {
        ftpClient.setConfig(serverFTPTest, options);
        return throwError(err);
      }),
    ).subscribe({
      error: err => done(err),
      complete: () => done(),
    });
  });
  afterEach(function(done) {
    this.timeout(0);
    ftpClient.setConfig(
      serverFTPTest,
      _.assign(_.clone(options), {
        logging: 'none',
      }),
    );
    const endObservable = of(null).pipe(
      tap(() => {
        ftpClient.setConfig(serverFTPTest, options);
      }),
      ignoreElements(),
    );
    ftpClient.connect().pipe(
      tap(() => console.info('After - Disconnecting and cleaning folders')),
      switchMapTo(
        ftpClient.deleteRemoteFile({
          src: remotePath,
          isDirectory: () => true,
        } as any)),
      switchMapTo(
        bindNodeCallback(rimraf).call(this,
          path.join(__dirname, downloadPath))),
      switchMapTo(
        ftpClient.disconnect()),
      tap(() => console.info('After - Done')),
      concat(endObservable),
      catchError((err) => {
        return endObservable.pipe(
          mapTo(throwError(err)),
        );
      }),
    ).subscribe({
      error: err => done(err),
      complete: () => done(),
    });
  });

  it(`Download a folder from the test server`, function(done) {
    const localFilePath = path.join(__dirname, downloadPath, testFiles[0]);
    ftpClient.download(remotePath, path.join(__dirname, downloadPath)).pipe(
      catchError((err) => {
        return ftpClient.disconnect().pipe(
          switchMapTo(throwError(err)),
        );
      }),
    )
      .subscribe(
        results => {
          expect(results, 'No results returned').to.exist;
          expect(results.downloadedFiles).to.be.length(3);
          expect(results.errors, 'Errors detected').to.be.empty;
          expect(file(path.join(localFilePath))).to.exist;
        },
        err => done(err),
        () => {
          expect(ftpClient.status).to.be.equal('disconnected');
          done();
        },
    );
  }).timeout(20000);
});
