const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

const appGlobals = {
  i18next: 'readonly',
  t: 'readonly',
  Theme: 'readonly',
  EventBus: 'readonly',
  ToastService: 'readonly',
  HtmlEncoder: 'readonly',
  DialogService: 'readonly',
  RepositoryLoadSession: 'readonly',
  RepositoryWorkspaceController: 'readonly',
  RemoteOperationController: 'readonly',
  ShortcutController: 'readonly',
  WorkspacePanelMotion: 'readonly',
  WorkspaceStateController: 'readonly',
  WorkspaceResizeController: 'readonly',
  LocalizedDateFormatter: 'readonly',
  PrCreatePrefill: 'readonly',
  DiffParser: 'readonly',
  ConflictHighlight: 'readonly',
  WelcomeScreen: 'readonly',
  RepoTabs: 'readonly',
  SettingsView: 'readonly',
  BranchContextMenu: 'readonly',
  CommitContextMenu: 'readonly',
  BranchListView: 'readonly',
  GraphView: 'readonly',
  ChangesView: 'readonly',
  PullRequestView: 'readonly',
  ChangesFileList: 'readonly',
  DiffViewer: 'readonly',
  GlobalSearch: 'readonly',
  BranchCompare: 'readonly',
  CommitCompare: 'readonly',
  MergeWorkspace: 'readonly',
  ConflictResolver: 'readonly',
  GitFlow: 'readonly',
  StatusBar: 'readonly',
  BranchNaming: 'readonly',
  I18n: 'readonly',
  ReflogView: 'readonly'
};

module.exports = [
  {
    ignores: [
      'dist/**',
      'build/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      'package-lock.json'
    ]
  },
  js.configs.recommended,
  {
    files: ['src/main/**/*.js', 'src/preload*.js', 'scripts/**/*.js', '.agents/**/*.js', '.qoder/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...require('globals').node,
        ...require('globals').commonjs
      }
    }
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...require('globals').browser,
        ...appGlobals
      }
    }
  },
  {
    files: ['src/**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
      globals: { ...globals.node }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...require('globals').node,
        ...require('globals').commonjs
      }
    }
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: require('globals').node
    }
  }
];
