// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Docs",
  url: "https://docs.enricospanier.com.br",
  baseUrl: "/",
  onBrokenLinks: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "pt-BR",
    locales: ["pt-BR"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.js",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      /** @type {import('@easyops-cn/docusaurus-search-local').PluginOptions} */
      ({
        hashed: true,
        language: ["pt", "en"],
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: "/",
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: "dark",
        respectPrefersColorScheme: false,
      },
      navbar: {
        title: "Docs",
        items: [
          {
            to: "/gerenciador-eventos/",
            label: "Gerenciador de Eventos",
            position: "left",
          },
          {
            to: "/testes/testes-manuais/",
            label: "Testes",
            position: "left",
          },
          {
            to: "/decisoes-arquitetura/visao-geral",
            label: "Decisões de Arquitetura",
            position: "left",
          },
        ],
      },
      footer: {
        style: "dark",
        copyright: "Gerado automaticamente a partir do repositório GerenciadorEventos e do vault de arquitetura.",
      },
    }),
};

module.exports = config;
