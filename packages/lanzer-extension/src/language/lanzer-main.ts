import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createLanzerServices } from 'lanzer';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

// Inject the shared services and Lanzer language-specific services
const { shared } = createLanzerServices({ connection, ...NodeFileSystem });

// Start the language server with the shared services
startLanguageServer(shared);
