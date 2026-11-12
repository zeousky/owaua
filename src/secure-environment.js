import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { protectEnvironmentFile } from './private-storage.js';

const setting = process.env.DOTENV_PATH ?? process.env.DOTENV_CONFIG_PATH;
const path = setting?.startsWith('~') ? join(homedir(), setting.slice(1)) : setting || '.env';
protectEnvironmentFile(path);
config({ path, quiet: process.env.DOTENV_QUIET ?? process.env.DOTENV_CONFIG_QUIET ?? true });
