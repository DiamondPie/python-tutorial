import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "DKD",
  description: "DiamondPie's Knowledge Database",
  appearance: 'dark',
  ignoreDeadLinks: true,
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Courses', link: '/courses' }
    ],

    sidebar: {
      // {
      //   text: 'Examples',
      //   items: [
      //     { text: 'Markdown Examples', link: '/markdown-examples' },
      //     { text: 'Runtime API Examples', link: '/api-examples' }
      //   ]
      // },
      '/': [{ text: '课程选择', link: '/courses' }],
      '/compsci_110/': [
        {
          text: 'COMPSCI 110',
          items: [
            { text: '0. 介绍', link: '/compsci_110' },
            { text: '1. 二的补码和浮点数表示', link: '/compsci_110/2c_and_floating' }
          ]
        },
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/DiamondPie' }
    ],
  },

  vite: {
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },

  // locales: {
  //   root: {
  //     label: 'English',
  //     lang: 'en'
  //   },
  //   fr: {
  //     label: '简体中文',
  //     lang: 'zh', // optional, will be added  as `lang` attribute on `html` tag
  //     link: '/zh/guide' // default /fr/ -- shows on navbar translations menu, can be external

  //     // other locale specific properties...
  //   },
  // },

  lastUpdated: true,

  markdown: {
    math: true
  }
})
