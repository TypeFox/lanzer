import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import {
    buildLanzerGenerationJobs,
    getCampaignFileAbsolutePath,
    loadLanzerDocumentFromFile,
    resolveLanzerCampaign,
    resolveLanzerCampaignFile,
    type LanzerCampaignValidationResult
} from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

const BENCH = fileURLToPath(new URL('../bench/', import.meta.url));

/**
 * Check `sources` (by file alias) against a bench campaign, the way a generation run would, in a
 * fresh copy of its workspace holding only the declared support files — the bench folder is where
 * `generate` writes a real agent's output.
 */
async function solve(name: string, sources: Record<string, string>): Promise<LanzerCampaignValidationResult> {
    const resolved = await resolveLanzerCampaignFile(join(BENCH, name), { validate: true });
    expect(resolved.issues).toEqual([]);
    const shipped = resolved.resolvedCampaigns[0].campaign;
    const workspace = await mkdtemp(join(tmpdir(), `lanzer-bench-${name.replace(/\.lanzer$/, '')}-`));
    for (const file of shipped.supportFiles) {
        const target = join(workspace, file.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(getCampaignFileAbsolutePath(shipped, file), target);
    }
    const campaign = resolveLanzerCampaign({ ...shipped, workspaceRoot: workspace });
    for (const job of buildLanzerGenerationJobs(campaign)) {
        const source = sources[job.fileAlias];
        if (source === undefined) {
            throw new Error(`No source given for ${job.fileAlias} in ${name}`);
        }
        await mkdir(dirname(job.absoluteOutputPath), { recursive: true });
        await writeFile(job.absoluteOutputPath, source, 'utf8');
    }
    return createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer.CampaignRunner.validateCampaign(campaign.request);
}

/** Every problem a verdict holds, so a failing reference solution says why. */
function problems(result: LanzerCampaignValidationResult): string[] {
    return [
        ...result.documents.filter((document) => !document.expectsDiagnostics).flatMap((document) => document.issues.map((issue) => issue.message)),
        ...(result.diagnostics?.issues ?? []),
        ...(result.campaign?.issues ?? []),
        ...(result.behaviour?.issues ?? []),
        ...(result.workspace?.issues ?? [])
    ];
}

/**
 * A reference solution per bench campaign: proof that each one can be met, so a setup that fails
 * it is failing the task and not an impossible campaign.
 */
const SOLUTIONS: Record<string, Record<string, string>> = {
    'higher-order.lanzer': {
        lib: `
fun makeAdder(n: number): (number) => number {
    fun add(x: number): number {
        return x + n;
    }
    return add;
}

fun compose(f: (number) => number, g: (number) => number): (number) => number {
    fun composed(x: number): number {
        return f(g(x));
    }
    return composed;
}

fun twice(f: (number) => number): (number) => number {
    return compose(f, f);
}

fun applyTimes(f: (number) => number, count: number, x: number): number {
    var result = x;
    for (var i = 0; i < count; i = i + 1) {
        result = f(result);
    }
    return result;
}
`
    },
    'integer-math.lanzer': {
        lib: `
fun remainder(a: number, b: number): number {
    var r = a;
    while (r >= b) {
        r = r - b;
    }
    return r;
}

fun gcd(a: number, b: number): number {
    if (b == 0) {
        return a;
    }
    return gcd(b, remainder(a, b));
}

fun isPrime(n: number): boolean {
    if (n < 2) {
        return false;
    }
    // A flag, not an early return: langium-lox's interpreter keeps looping after a return inside a
    // while, so the return would not leave the loop.
    var prime = true;
    var d = 2;
    while (prime and ((d * d) <= n)) {
        if (remainder(n, d) == 0) {
            prime = false;
        }
        d = d + 1;
    }
    return prime;
}
`
    },
    'negative-subclass.lanzer': {
        mistake: `
class Animal {
    name: string
    speak(): string {
        return this.name + " makes a sound";
    }
}

class Dog < Animal {
    fetch(): string {
        return this.name + " fetches";
    }
}

var dog = Dog();
dog.name = "Rex";
var pet: Animal = dog;
var impostor: Dog = Animal();
`
    },
    'shapes.lanzer': {
        lib: `
class Shape {
    area(): number {
        return 0;
    }
    describe(): string {
        return "shape with area " + this.area();
    }
}

class Rectangle < Shape {
    width: number
    height: number
    area(): number {
        return this.width * this.height;
    }
    describe(): string {
        return "rectangle " + this.width + "x" + this.height;
    }
}

class Square < Rectangle {
    setSide(side: number): void {
        this.width = side;
        this.height = side;
    }
    describe(): string {
        return "square, a " + super.describe();
    }
}
`
    },
    'linked-stack.lanzer': {
        lib: `
class Node {
    value: number
    next: Node
}

class Stack {
    top: Node
    push(value: number): void {
        var node = Node();
        node.value = value;
        node.next = this.top;
        this.top = node;
    }
    pop(): number {
        var value = this.top.value;
        this.top = this.top.next;
        return value;
    }
    peek(): number {
        return this.top.value;
    }
    size(): number {
        var count = 0;
        var node = this.top;
        while (node != nil) {
            count = count + 1;
            node = node.next;
        }
        return count;
    }
    isEmpty(): boolean {
        return this.top == nil;
    }
}
`
    }
};

describe('the Lox benchmark suite', () => {
    const campaigns = readdirSync(BENCH).filter((name) => name.endsWith('.lanzer')).sort();

    test('ships a reference solution for every campaign', () => {
        expect(Object.keys(SOLUTIONS).sort()).toEqual(campaigns);
    });

    test.each(campaigns)('%s is valid', async (name) => {
        const result = await loadLanzerDocumentFromFile(join(BENCH, name), { validate: true });
        expect(result.issues).toEqual([]);
    });

    test.each(campaigns)('%s is met by its reference solution', async (name) => {
        const result = await solve(name, SOLUTIONS[name] ?? {});
        expect(problems(result)).toEqual([]);
        expect(result.ok).toBe(true);
    });
});
