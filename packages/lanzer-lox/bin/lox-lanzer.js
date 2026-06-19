#!/usr/bin/env node
import { createLoxLanzerCli } from '../out/cli.js';

createLoxLanzerCli().parse(process.argv);
