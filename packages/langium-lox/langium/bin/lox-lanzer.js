#!/usr/bin/env node
import { createLoxLanzerCli } from '../lib/cli/lox-lanzer.js';

createLoxLanzerCli().parse(process.argv);
