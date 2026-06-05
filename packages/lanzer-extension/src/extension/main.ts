import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';

let lanzerClient: LanguageClient;

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    lanzerClient = await startLanzerLanguageClient(context);
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (lanzerClient) {
        return lanzerClient.stop();
    }
    return undefined;
}

async function startLanzerLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient> {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'lanzer-main.cjs'));

    // The debug options for the server
    // --inspect=6010: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging.
    // By setting `process.env.DEBUG_BREAK` to a truthy value, the language server will wait until a debugger is attached.
    const debugOptions = { execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6010'}`] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: '*', language: 'lanzer' }]
    };

    const client = new LanguageClient(
        'lanzer',
        'Lanzer',
        serverOptions,
        clientOptions
    );

    await client.start();
    return client;
}
