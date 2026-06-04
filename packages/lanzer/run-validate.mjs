import { resolve, dirname } from 'node:path';

const repoRoot = '/Users/praisethemoon/praisethemoon/type-c/claude/langium-llm-fuzzer';

async function main() {
    const { createTypeCServices } = await import(`${repoRoot}/packages/language/out/type-c-module.js`);
    const { NodeFileSystem } = await import(`${repoRoot}/node_modules/langium/lib/node/index.js`);
    const { TypeCLanzerService } = await import(`${repoRoot}/packages/compiler/out/lanzer/typec-lanzer.js`);
    const { resolveLanzerCampaignFile } = await import(`${repoRoot}/packages/lanzer/out/campaign/resolve.js`);
    
    const { shared, TypeC: language } = createTypeCServices(NodeFileSystem);
    const service = new TypeCLanzerService(shared, language);
    
    const specPath = `${repoRoot}/stress-tests-2/spec/stress-0003-lzss-literal-flag.lanzer`;
    const resolved = await resolveLanzerCampaignFile(specPath);
    const campaign = resolved.campaigns[0];
    
    // Initialize workspace
    const baseDir = campaign.baseDir && campaign.workspaceRoot
        ? resolve(campaign.baseDir, campaign.workspaceRoot)
        : (campaign.workspaceRoot ?? campaign.baseDir ?? process.cwd());
    
    const { URI } = await import('langium');
    await service.initializeWorkspace([{
        uri: URI.file(baseDir).toString(),
        name: 'stress'
    }]);
    
    const specs = campaign.files.map(file => ({path: resolve(baseDir, file.path)}));
    const docs = await service.loadDocuments(specs);
    console.log("docs loaded:", docs.length);
    
    await service.buildDocuments(docs);
    
    const result = await service.validateCampaignResult({campaign}, docs);
    console.log("validation result:");
    console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
