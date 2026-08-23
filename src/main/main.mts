import { createRequire } from 'node:module';
import { createMainApplication } from './main-application.mts';

const require = createRequire(import.meta.url);
const electron = require('electron') as typeof import('electron');

createMainApplication({ electron }).start();
