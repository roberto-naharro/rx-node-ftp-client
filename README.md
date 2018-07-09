# Description
rx-node-ftp-client is an observable version of the package  [ftp-client](http://nodejs.org/) - with some improvements.


# Requirements

* [node.js](http://nodejs.org/) -- v0.8.0 or newer
* npm -- v2.0.0 or newer


# Dependencies

* [rxjs](https://github.com/mscdex/node-ftp) -- v6.2.1
* [ftp](https://github.com/mscdex/node-ftp) -- v0.3.10
* [glob](https://github.com/isaacs/node-glob) -- v7.1.2
* [lodash](https://github.com/lodash/lodash-node) -- v4.17.10
* [path](https://github.com/jinder/path) -- v4.17.10
* [upath](https://github.com/jinder/path) -- v1.1.10

# Installation

    npm install rx-node-ftp-client

# Usage

## Initialization
To crate an instance of the wrapper use the following code:

TypeSript:
```typescript
import { Client } from 'rx-node-ftp-client';
ftpClient = new Client(config, options);
```
Javascript
```javascript
var FtpClient = require('rx-node-ftp-client'),
ftpClient = new FtpClient.client(config, options);
```

where `config` contains the ftp server configuration (these are the default values):
```javascript
{
    host: 'localhost',
    port: 21,
    user: 'anonymous',
    password: 'anonymous@'
}
```
(To check more options, see [the ftp npm package](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/ftp/index.d.ts#L18))

and the `options` object may contain the following keys:

* *logging* (String): 'none', 'basic', 'debug' - level of logging for all the tasks - use 'debug' in case of any issues
* *Logger* (Console): default console - if you want to inject your custom logger, use this property
* *overwrite* (String): 'none', 'older', 'all' - determines which files should be overwritten when downloading/uploading - 'older' compares the date of modification of local and remote files
* *testingTimezoneDir* (String): default null - using default home directory if null. The directory should have Read/Write permission in order to adjust timezone for overwriting files.
* *globOptions* (Glob configuraion object): default `{ nonull: false }` - Custom glob options for file search.
* *disconnect* (boolean): default true - disconnect from ftp after an upload or download operation.

### Connecting
After creating the new object you have to manually connect to the server by using the `connect` method:
```typescript
ftpClient.connect().subscribe(
  () => console.log('Connected'),
  err => console.error(err),
  () => {
    console.log('Operation finished'),
  },
);
```

### Disconnected
If you choose the option of manually disconnect from the server, you have to use the `disconnect` method:
```typescript
ftpClient.disconnect().subscribe(
  () => console.log('Disconnected'),
  err => console.error(err),
  () => {
    console.log('Operation finished'),
  },
);
```

## Methods
* **download**(source: string, dest: string, options?: Options):
  Observable<DownloadResults> - downloads the contents
of `source` to `dest` if both exist. The next function returns the following object:
```typescript
{
  downloadedFiles: string[],
  errors: {
    [origin: string]: Error,
  },
}
```

* **upload**(patterns: string | string[], dest: string,
  options?: Options): Observable<UploadResults> - expands the source paths
using the glob module to the (`patterns` argument), uploads all found files and directories to the specified `dest`. The next function returns the following object:
```typescript
{
  uploadedFiles: string[],
  uploadedDirs: string[],
  errors: {
    [origin: string]: Error,
  },
}
```

# Examples
In this example we connect to a server, and simultaneously upload all files from the `test` directory, overwriting only
older files found on the server, and download files from `/public_html/test` directory.

```typescript
import { Client, Options, Config } from './lib/client';
import * as upath from 'upath';
import { switchMapTo } from 'rxjs/operators';

const config: Config = {
  host: 'localhost',
  port: 21,
  user: 'anonymous',
  password: 'anonymous@',
};
const options: Options = {
  logging: 'basic',
};

const ftpClient = new Client(config, options);

ftpClient.connect().pipe(
  switchMapTo(ftpClient.upload(
    upath.join(__dirname, 'test/*'),
    './',
    { baseDir: __dirname },
  )),
).subscribe(
  results => console.info(results),
  err => console.error(err),
  () => console.info('Upload Complete'),
);

ftpClient.connect().pipe(
  switchMapTo(ftpClient.download(
    '/public_html/test',
    __dirname,
  )),
).subscribe(
  results => console.info(results),
  err => console.error(err),
  () => console.info('Download Complete'),
);
```

TODO
====
* Update this document with the different functions added
