# Plug in your DSL

Your language stays **unmodified**. You add a small host package that depends on `lanzer` and on your language. [`packages/lanzer-lox`](https://github.com/TypeFox/lanzer/tree/main/packages/lanzer-lox) is the template: four short files.

```text
my-lang-lanzer/
  src/my-lanzer-service.ts   1. what the agent is told, and how programs run
  src/my-host.ts             2. wiring: your language on Lanzer's services
  src/cli.ts                 3. the CLI
  bin/my-lanzer.js
```

## 1. The service

Extend `DefaultLanzerService` and override what your language needs:

```ts
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { DefaultLanzerService, type LanzerGenerationJob, type LanzerGenerationPolicy,
    type LanzerDslSkillReference, type LanzerExecutionRequest, type LanzerExecutionResult } from 'lanzer';

export class MyLanzerService extends DefaultLanzerService {
    constructor(shared: LangiumSharedServices, language: LangiumServices, readonly options: { skillPath?: string } = {}) {
        super(shared, language);
    }

    // Language advice for the prompt, on top of the grammar reference.
    override async getGenerationPolicy(job: LanzerGenerationJob): Promise<LanzerGenerationPolicy | undefined> {
        const base = await super.getGenerationPolicy(job);
        return {
            ...base,
            requiredPractices: ['Declare a type on every variable.'],
            forbiddenPractices: ['Do not use reflection.']
        };
    }

    // Where your agent skill lives; `--skill <dir>` overrides it.
    override async dslSkill(): Promise<LanzerDslSkillReference | undefined> {
        return { name: 'write-mylang', path: this.options.skillPath ?? '/path/to/skills/write-mylang' };
    }

    // Optional: run a program, for `run` blocks. Bound time and output: the code is agent-written.
    async execute(request: LanzerExecutionRequest): Promise<LanzerExecutionResult> {
        const output = await runMyLang(request.entry, request.documents);
        return { completed: true, output, timedOut: false, durationMs: 0 };
    }

    // Optional: every diagnostic code, so a campaign expecting an unknown one fails early.
    async diagnosticCodes(): Promise<readonly string[]> {
        return ['MY_TYPE_MISMATCH', 'MY_UNKNOWN_NAME'];
    }
}
```

| Override | Needed for |
|---|---|
| `getGenerationPolicy` | Language advice in the prompt. |
| `dslSkill` | Pointing the agent at your skill. |
| `execute` | `run` blocks. Without it they fail rather than pass unchecked. |
| `diagnosticCodes` | Checking `expect error code "…"` before an agent starts. |

::: details Optional: the campaign runner
Extend `DefaultLanzerCampaignRunner` to override `failsCleanFile(issue)`, which decides which issues fail an ordinary file (Lox: errors only), or `collectDocumentResult`, to add codes to diagnostics that lack them. Decide what fails in `failsCleanFile`; don't drop issues, or a negative file can't `expect` them.
:::

## 2. The wiring

The same `inject` your `create<Lang>Services` already does, with Lanzer's shared container handed in:

```ts
import { inject } from 'langium';
import { createDefaultModule, type DefaultSharedModuleContext } from 'langium/lsp';
import { createLanzerHostServices, DefaultLanzerCampaignRunner } from 'lanzer';
import { MyLangAstReflection, MyLangGeneratedModule, MyLangGeneratedSharedModule, MyLangModule } from 'my-lang';

export function createMyLanzerServices(context: DefaultSharedModuleContext, options: { skillPath?: string } = {}) {
    return createLanzerHostServices(context, {
        generatedSharedModule: MyLangGeneratedSharedModule,
        createServices: (shared) => inject(createDefaultModule({ shared }), MyLangGeneratedModule, MyLangModule),
        astReflection: () => new MyLangAstReflection()
    }, {
        service: (shared, language) => new MyLanzerService(shared, language, options),
        campaignRunner: (services) => new DefaultLanzerCampaignRunner(services)
    });
}
```

## 3. The CLI

`createLanzerHostCli` gives you all the [commands](./commands) and flags:

```ts
import { NodeFileSystem } from 'langium/node';
import { createLanzerHostCli } from 'lanzer';

// Fresh services for every run, so one run can never pass on a name another run wrote.
export const createMyDeps = (options: { skillPath?: string } = {}) => {
    const { Lanzer } = createMyLanzerServices(NodeFileSystem, options);
    return { service: Lanzer.lanzer.Lanzer, runner: Lanzer.lanzer.CampaignRunner };
};

export const createMyLanzerCli = () => createLanzerHostCli({
    name: 'my-lanzer',
    language: 'MyLang',
    label: 'mylang',
    skillName: 'write-mylang',
    fileExtension: '.my',
    createService: (options) => createMyDeps(options).service,
    createDeps: createMyDeps
});
```

```js
#!/usr/bin/env node
import { createMyLanzerCli } from '../out/cli.js';
createMyLanzerCli().parse(process.argv);
```

## In code, without the CLI

```ts
import { runLanzerCampaignFiles, resolveAcpOptionsFromEnv } from 'lanzer';

const { runs } = await runLanzerCampaignFiles(['campaign.lanzer'], resolveAcpOptionsFromEnv(), () => createMyDeps());
```

For full control — batching, custom retries, another transport — build the jobs yourself with `buildLanzerGenerationJobs` and `runLanzerCampaignTaskOverAcp`.
