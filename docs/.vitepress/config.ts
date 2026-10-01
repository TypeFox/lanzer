import { defineConfig } from 'vitepress';
import lanzer from '../../packages/lanzer/syntaxes/lanzer.tmLanguage.json' with { type: 'json' };
import lox from '../../packages/langium-lox/vscode/syntaxes/lox.tmLanguage.json' with { type: 'json' };

const repo = 'https://github.com/TypeFox/lanzer';
// GitHub Pages serves the site under the repository's name.
const base = '/lanzer/';

export default defineConfig({
    title: 'Lanzer',
    description: 'Measure how well coding agents write your Langium DSL',
    base,
    cleanUrls: true,
    head: [['link', { rel: 'icon', href: `${base}lanzer.webp` }]],
    markdown: {
        // The real Lanzer and Lox grammars, so ```lanzer and ```lox blocks are highlighted.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        languages: [lanzer as any, lox as any]
    },
    themeConfig: {
        logo: '/lanzer.webp',
        nav: [{ text: 'Guide', link: '/guide/getting-started' }],
        sidebar: [
            {
                text: 'Start',
                items: [
                    { text: 'Getting started', link: '/guide/getting-started' },
                    { text: 'The Lanzer DSL', link: '/guide/campaigns' }
                ]
            },
            {
                text: 'Running',
                items: [
                    { text: 'Commands', link: '/guide/commands' },
                    { text: 'Agents and permissions', link: '/guide/agents' },
                    { text: 'Repeated and parallel runs', link: '/guide/runs' },
                    { text: 'Evaluating a skill', link: '/guide/evaluating-a-skill' }
                ]
            },
            {
                text: 'Your language',
                items: [
                    { text: 'Plug in your DSL', link: '/guide/your-dsl' }
                ]
            }
        ],
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: repo }],
        editLink: { pattern: `${repo}/edit/main/docs/:path` },
        footer: {
            message: 'Released under the MIT License.',
            copyright: 'Made with ♥ by <a href="https://www.typefox.io/">TypeFox GmbH</a>'
        }
    }
});
