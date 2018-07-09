import * as chai from 'chai';
import * as chaiFiles from 'chai-files';
chai.use(chaiFiles);
export const expect = chai.expect;
export const dir = chaiFiles.dir;
export const file = chaiFiles.file;
