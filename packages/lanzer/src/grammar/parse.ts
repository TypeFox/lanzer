import { GrammarAST, URI } from 'langium';
import { createLangiumGrammarServices, type LangiumGrammarServices } from 'langium/grammar';
import { NodeFileSystem } from 'langium/node';

export interface ParseLanzerHostGrammarOptions {
    source: string;
    uri?: string;
    validate?: boolean;
}

export interface ParsedLanzerHostGrammar {
    grammar: GrammarAST.Grammar;
}

let grammarServices: LangiumGrammarServices | undefined;

function getGrammarServices(): LangiumGrammarServices {
    grammarServices ??= createLangiumGrammarServices(NodeFileSystem).grammar;
    return grammarServices;
}

export async function parseLanzerHostGrammar(
    options: ParseLanzerHostGrammarOptions
): Promise<ParsedLanzerHostGrammar> {
    const services = getGrammarServices();
    const uri = URI.parse(options.uri ?? 'memory:/grammar.langium');
    const document = services.shared.workspace.LangiumDocumentFactory.fromString<GrammarAST.Grammar>(
        options.source,
        uri
    );
    await services.shared.workspace.DocumentBuilder.build([document], {
        validation: options.validate ?? true
    });

    return {
        grammar: document.parseResult.value
    };
}
