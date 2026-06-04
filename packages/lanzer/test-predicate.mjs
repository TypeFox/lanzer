import { evaluateSelector } from './src/validations/selector-evaluator.js';
import { interpretAstReflection } from 'langium/grammar';
import { createLangiumGrammarServices } from 'langium/grammar';
import { URI } from 'langium';
import { createTypeCServices } from '../language/out/type-c-module.js';
import { NodeFileSystem } from 'langium/node';
import * as fs from 'node:fs';

const services = createTypeCServices(NodeFileSystem);
const tc = services.TypeC;
const workspaceRoot = '/Users/praisethemoon/praisethemoon/type-c/claude/langium-llm-fuzzer/stress-tests-2/code/stress-0001-lz77-sliding-window';
await tc.shared.workspace.WorkspaceManager.initializeWorkspace([{ name: 'ws', uri: URI.file(workspaceRoot).toString() }]);
const root = `${workspaceRoot}/src`;
const docs = [];
for (const f of fs.readdirSync(root)) {
    docs.push(await tc.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(`${root}/${f}`)));
}
await tc.shared.workspace.DocumentBuilder.build(docs, { validation: false });
const main = docs.find(d => d.uri.fsPath.endsWith('main.tc'));

const grammarServices = createLangiumGrammarServices(NodeFileSystem);
const grammarText = fs.readFileSync('/Users/praisethemoon/praisethemoon/type-c/claude/langium-llm-fuzzer/packages/language/src/type-c.langium', 'utf8');
const grammarDoc = grammarServices.shared.workspace.LangiumDocumentFactory.fromString(grammarText, URI.file('grammar.langium'));
grammarServices.shared.workspace.LangiumDocuments.addDocument(grammarDoc);
await grammarServices.shared.workspace.DocumentBuilder.build([grammarDoc]);
const reflection = interpretAstReflection(grammarDoc.parseResult.value);

// Selector with NO name predicate
const sel = {
    leadingCombinator: '>>',
    parts: [
        { astType: 'FunctionDeclaration', predicates: [{ kind: 'value', property: 'name', op: '^=', value: 'test_case_' }], pseudos: [] },
        { astType: 'MemberAccess', predicates: [{ kind: 'crossRef', property: 'element', targetAstType: 'MethodHeader', nestedPredicates: [] }], pseudos: [] }
    ],
    combinators: ['>>']
};
console.log('no nested pred:', evaluateSelector(sel, main.parseResult.value, reflection).length);

// Selector with names predicate
sel.parts[1].predicates[0].nestedPredicates = [{ kind: 'value', property: 'names', op: '^=', value: 'assert_' }];
console.log('with names^=assert_:', evaluateSelector(sel, main.parseResult.value, reflection).length);

// Selector with names = 'assert_eq'
sel.parts[1].predicates[0].nestedPredicates = [{ kind: 'value', property: 'names', op: '=', value: 'assert_eq' }];
console.log('with names=assert_eq:', evaluateSelector(sel, main.parseResult.value, reflection).length);

