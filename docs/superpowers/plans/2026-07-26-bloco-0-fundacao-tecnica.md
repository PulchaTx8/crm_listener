# Bloco 0 — Fundação Técnica — Implementation Plan

> **HISTORICAL ARTIFACT — deliberately left in Portuguese.** This is the completed
> record of an already-executed block, written before the English-only language
> decision and the PulchatX naming/vocabulary decision. It will never drive work
> again, so it was excluded from the language migration. Its terminology is
> pre-migration: read `docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md`
> for the current vocabulary, and `docs/language-migration-report.md` for the
> scope call. Do not use this file as a naming reference.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Erguer o esqueleto do projeto Next.js/Supabase com todos os guard-rails (env validado no boot, dois clients Supabase isolados, taxonomia de erros, logging estruturado, mailer e rate-limit desacoplados, testes, CI e Docker), pronto para o Bloco 1 construir identidade/multi-tenant em cima.

**Architecture:** App Next.js (App Router, TypeScript strict) com camada `lib/` de infraestrutura transversal. Toda regra sensível fica no servidor; o client `service_role` do Supabase é isolado do bundle do navegador. Validação de ambiente falha o boot. Operações atômicas futuras irão para funções PL/pgSQL — este bloco só prepara o pipeline de migrations e um exemplo (rate limit).

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript 5 (strict) · Tailwind CSS 3.4 + shadcn/ui (Radix) · Zod · Supabase (`@supabase/supabase-js` + `@supabase/ssr`) · pino (logs) · nodemailer (SMTP) · Vitest (unit) · Playwright (e2e) · pgTAP (RLS/DB) · GitHub Actions · Docker.

## Global Constraints

- **Node.js** ≥ 20; gerenciador de pacotes **npm** (usar `package-lock.json`).
- **TypeScript strict**; proibido `any` sem justificativa em comentário.
- **App Router**; Server Components por padrão, Client Components só quando necessário.
- **UI só com Tailwind + shadcn/ui** — nada de Bootstrap.
- **Env validado no boot**: ambiente inválido deve lançar e impedir o start (exceto durante `next build`, quando `SKIP_ENV_VALIDATION=1`).
- **`SUPABASE_SERVICE_ROLE_KEY` nunca entra no bundle do cliente** — módulo do client de sistema marcado com `server-only`.
- **Nunca logar** senhas, tokens, `service_role`, CPF/passaporte completos, `authorization` (redação obrigatória no logger).
- Todo commit passa `npm run lint`, `npm run typecheck` e `npm run test`.
- **Conventional Commits** nas mensagens.
- Caminho do projeto: raiz `M:\CRM - LISTENER` (já é repositório git com `origin/main`). Alias de import: `@/*` → `src/*`.

---

## File Structure

Criados neste bloco:

- `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config.mjs`, `tailwind.config.ts`, `.eslintrc.json`, `.prettierrc.json`, `.env.example`, `.dockerignore`, `Dockerfile`, `components.json`, `vitest.config.ts`, `playwright.config.ts`
- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- `src/lib/utils.ts` — helper `cn()` (shadcn)
- `src/components/ui/button.tsx` — primeiro componente shadcn
- `src/lib/env.ts` — validação de ambiente (Zod)
- `src/lib/errors.ts` — taxonomia de erros (§25)
- `src/lib/logger.ts` — logger estruturado + correlação + redação (§31)
- `src/lib/supabase/config.ts` — resolução de configuração (testável)
- `src/lib/supabase/user-client.ts` — client com JWT do usuário (RLS aplicada)
- `src/lib/supabase/service-client.ts` — client `service_role` isolado (`server-only`)
- `src/lib/supabase/README.md` — documenta os dois clients (D4)
- `src/lib/mailer/index.ts` — interface `Mailer` + `DevMailer` + `SmtpMailer`
- `src/lib/rate-limit/index.ts` — interface `RateLimiter` + `InMemoryRateLimiter` + `PostgresRateLimiter`
- `supabase/config.toml` (via CLI) + `supabase/migrations/0001_extensions.sql` + `supabase/migrations/0002_rate_limit.sql`
- `supabase/tests/00_smoke.test.sql` — smoke pgTAP
- `.github/workflows/ci.yml`
- Testes: `tests/unit/env.test.ts`, `tests/unit/errors.test.ts`, `tests/unit/logger.test.ts`, `tests/unit/supabase-config.test.ts`, `tests/unit/mailer.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/e2e/home.spec.ts`

---

## Task 1: Scaffold Next.js + TypeScript strict

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `postcss.config.mjs`, `tailwind.config.ts`

**Interfaces:**
- Produces: app Next.js que builda e faz typecheck; alias `@/*`.

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "crm-listener",
  "version": "0.1.0",
  "private": true,
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint --dir src --dir tests",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:reset": "supabase db reset",
    "db:test": "supabase test db"
  },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.23.8",
    "@supabase/supabase-js": "^2.45.0",
    "@supabase/ssr": "^0.5.1",
    "pino": "^9.4.0",
    "nodemailer": "^6.9.15",
    "server-only": "^0.0.1",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.2",
    "tailwindcss-animate": "^1.0.7",
    "lucide-react": "^0.454.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^20.16.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/nodemailer": "^6.4.16",
    "eslint": "^8.57.1",
    "eslint-config-next": "^15.1.0",
    "@typescript-eslint/eslint-plugin": "^8.65.0",
    "@typescript-eslint/parser": "^8.65.0",
    "prettier": "^3.3.3",
    "tailwindcss": "^3.4.14",
    "postcss": "^8.4.47",
    "autoprefixer": "^10.4.20",
    "vitest": "^2.1.0",
    "@playwright/test": "^1.48.0",
    "pino-pretty": "^13.0.0"
  }
}
```

> **Nota de execução:** três correções da revisão final do bloco. (1) `engines.node`
> torna explícita a Global Constraint “Node ≥ 20”. (2) `next lint` sozinho só
> percorre `ESLINT_DEFAULT_DIRS` — neste layout, apenas `src/` — então `tests/`
> ficava sem `@typescript-eslint/no-explicit-any`, que é a única aplicação da
> regra “sem `any`”; daí `--dir src --dir tests`. (3) `@typescript-eslint/*`
> chegava só transitivamente via `eslint-config-next`, frágil para regras das
> quais o projeto depende — agora estão pinados. A migração para a ESLint CLI
> (o `next lint` está deprecado no Next 16) fica para um bloco posterior.

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Criar `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Top-level desde o Next 15.5; `experimental.typedRoutes` está deprecado.
  typedRoutes: true,
};

export default nextConfig;
```

> **Nota de execução:** o plano original trazia `experimental: { typedRoutes: true }`,
> que no Next 15.5 (versão instalada) imprime um aviso de deprecação em todo
> `next build`. Movido para o top-level; o aviso desapareceu.

- [ ] **Step 4: Criar `postcss.config.mjs` e `tailwind.config.ts`**

`postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      // Mapeia as CSS variables de `src/app/globals.css` para os tokens
      // semânticos que o shadcn/ui gera (`cssVariables: true`).
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;
```

> **Nota de execução:** o plano original trazia `theme: { extend: {} }`, o que
> contradizia `components.json: tailwind.cssVariables = true` (Task 3 Step 1).
> Ver a Nota de execução da Task 3 Step 3 para o raciocínio completo.

- [ ] **Step 5: Criar `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`**

`src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Camada de tokens do shadcn/ui (baseColor `slate`), exigida por
   `components.json: tailwind.cssVariables = true`. Sem ela, todo componente
   gerado por `npx shadcn add` (que emite `bg-primary`, `border-input`, …)
   renderiza sem estilo. */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CRM Rádios',
  description: 'CRM multi-tenant para rádios',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
export default function Home() {
  return <main className="p-8 text-2xl font-semibold">CRM Rádios — Fundação OK</main>;
}
```

- [ ] **Step 6: Instalar dependências**

Run: `npm install`
Expected: `package-lock.json` gerado, sem erros.

- [ ] **Step 7: Verificar build e typecheck**

Run: `npm run typecheck && SKIP_ENV_VALIDATION=1 npm run build`
Expected: typecheck sem erros; build conclui e cria `.next/`.
(No Windows PowerShell: `$env:SKIP_ENV_VALIDATION=1; npm run build`.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.mjs postcss.config.mjs tailwind.config.ts src/app
git commit -m "chore: scaffold next.js app router + typescript strict"
```

---

## Task 2: ESLint + Prettier

**Files:**
- Create: `.eslintrc.json`, `.prettierrc.json`

**Interfaces:**
- Produces: `npm run lint` e `npm run format` funcionando.

> Nota: usamos o formato tradicional `.eslintrc.json` (não flat-config) porque o `next lint` o suporta de forma estável; por isso o pin de `eslint@^8.57` na Task 1.

- [ ] **Step 1: Criar `.eslintrc.json`**

```json
{
  "extends": "next/core-web-vitals",
  "plugins": ["@typescript-eslint"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "ignoreRestSiblings": true }
    ]
  },
  "ignorePatterns": [".next/", "node_modules/", "supabase/"]
}
```

> **Nota de execução:** dois desvios do texto original. (1) `plugins:
> ["@typescript-eslint"]` é obrigatório — sob `next/core-web-vitals` as regras
> `@typescript-eslint/*` não resolvem sem ele (verificado com
> `eslint --print-config`). (2) `varsIgnorePattern` + `ignoreRestSiblings`
> vieram junto com a ampliação do `lint` para `tests/` (Task 1 Step 1): sem eles
> o padrão idiomático de omitir uma chave via desestruturação
> (`const { X: _omit, ...rest } = obj`) vira erro.

- [ ] **Step 2: Criar `.prettierrc.json`**

```json
{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 3: Rodar lint**

Run: `npm run lint`
Expected: PASS (sem erros; avisos aceitáveis).

- [ ] **Step 4: Commit**

```bash
git add .eslintrc.json .prettierrc.json
git commit -m "chore: add eslint + prettier"
```

---

## Task 3: Tailwind + shadcn/ui (cn + Button)

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/components/ui/button.tsx`
- Modify: `src/app/page.tsx` (usar o Button)

**Interfaces:**
- Produces: `cn(...classes)` de `@/lib/utils`; componente `Button` de `@/components/ui/button`.

- [ ] **Step 1: Criar `components.json`**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": { "config": "tailwind.config.ts", "css": "src/app/globals.css", "baseColor": "slate", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui" }
}
```

- [ ] **Step 2: Criar `src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Criar `src/components/ui/button.tsx`**

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
      },
      size: { default: 'h-10 px-4 py-2', sm: 'h-9 px-3', lg: 'h-11 px-8' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
```

> **Nota de execução:** o plano original usava utilitários `slate-*` fixos aqui,
> enquanto o `components.json` do Step 1 declara `cssVariables: true` e o
> `tailwind.config.ts` não tinha mapeamento algum. A contradição só apareceria
> no primeiro `npx shadcn add` do Bloco 1: o componente gerado emitiria
> `bg-primary`/`text-primary-foreground`/`border-input` e renderizaria sem
> estilo. Resolvido shippando a camada de tokens padrão do shadcn (baseColor
> `slate`): CSS variables em `globals.css` para claro/escuro, o
> `theme.extend.colors` correspondente em `tailwind.config.ts` (ambos na Task 1)
> e este componente passando a usar os tokens semânticos. A alternativa estreita
> — `cssVariables: false` — foi descartada porque o Bloco 1 tem trabalho de UI e
> `true` é o estado final mais útil.
>
> O bloco `.dark { … }` só aparece no CSS compilado quando alguma classe `dark`
> existir no `content` (tree-shaking normal do Tailwind v3 em `@layer base`);
> ele volta sozinho quando o toggle de tema chegar.

- [ ] **Step 4: Usar o Button em `src/app/page.tsx`**

```tsx
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">CRM Rádios — Fundação OK</h1>
      <Button>Começar</Button>
    </main>
  );
}
```

- [ ] **Step 5: Verificar build**

Run: `npm run typecheck && SKIP_ENV_VALIDATION=1 npm run build`
Expected: PASS; página renderiza o Button.

- [ ] **Step 6: Commit**

```bash
git add components.json src/lib/utils.ts src/components/ui/button.tsx src/app/page.tsx
git commit -m "feat: add tailwind + shadcn/ui (cn + button)"
```

---

## Task 4: Vitest (unit)

**Files:**
- Create: `vitest.config.ts`, `tests/unit/sanity.test.ts`

**Interfaces:**
- Produces: `npm run test` roda testes unitários em `tests/unit/**`.

- [ ] **Step 1: Criar `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

- [ ] **Step 2: Escrever o teste que falha**

`tests/unit/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('mescla classes tailwind resolvendo conflitos', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
```

- [ ] **Step 3: Rodar e ver passar**

Run: `npm run test`
Expected: PASS (1 teste). Confirma que o runner e o alias `@` funcionam.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tests/unit/sanity.test.ts
git commit -m "test: add vitest setup + sanity test"
```

---

## Task 5: Playwright (e2e smoke)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/home.spec.ts`

**Interfaces:**
- Produces: `npm run test:e2e` sobe o dev server e verifica a home.

- [ ] **Step 1: Instalar navegadores**

Run: `npx playwright install --with-deps chromium`
Expected: chromium instalado.

- [ ] **Step 2: Criar `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    env: { SKIP_ENV_VALIDATION: '1' },
  },
});
```

- [ ] **Step 3: Escrever o teste smoke**

`tests/e2e/home.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('home mostra o título da fundação', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Fundação OK/ })).toBeVisible();
});
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test:e2e`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/e2e/home.spec.ts
git commit -m "test: add playwright e2e smoke"
```

---

## Task 6: Validação de ambiente no boot (TDD)

**Files:**
- Create: `src/lib/env.ts`, `src/instrumentation.ts`, `.env.example`, `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `parseEnv(source: NodeJS.ProcessEnv): Env` (lança em ambiente inválido); `parseLooseEnv(source): LooseEnv`; `env: Env | LooseEnv` (validado no import, exceto se `SKIP_ENV_VALIDATION` estiver setado). `Env` tem: `NODE_ENV`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_URL?`, `MAIL_FROM?`.
- Produces: `register()` em `src/instrumentation.ts` — o hook que o Next chama no boot do servidor e que dispara a validação.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/env.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnv } from '@/lib/env';

const valid = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
} as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('aceita ambiente válido', () => {
    const env = parseEnv(valid);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('lança quando falta variável obrigatória', () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...rest } = valid;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('lança quando a URL do supabase é inválida', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrow();
  });
});

// O módulo é importado por `src/instrumentation.ts`, então o throw no topo do
// módulo é o que impede o servidor de subir. Estes testes travam esse contrato.
// `vitest.config.ts` define SKIP_ENV_VALIDATION=1 globalmente — cada caso
// sobrescreve o process.env e restaura depois.
describe('validação no import do módulo', () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  });

  it('lança ao importar o módulo com ambiente inválido', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

    await expect(import('@/lib/env')).rejects.toThrow(/Configuração de ambiente inválida/);
  });

  it('não lança ao importar com ambiente válido', async () => {
    vi.resetModules();
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    const mod = await import('@/lib/env');
    expect(mod.env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('sob SKIP_ENV_VALIDATION tolera ausência e aplica o default de NODE_ENV', async () => {
    vi.resetModules();
    process.env.SKIP_ENV_VALIDATION = '1';
    // NODE_ENV é readonly no @types/node — `delete` direto não compila.
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const mod = await import('@/lib/env');
    expect(mod.env.NODE_ENV).toBe('development');
    expect(mod.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- env`
Expected: FAIL ("Cannot find module '@/lib/env'").

- [ ] **Step 3: Implementar `src/lib/env.ts`**

```ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().email().optional(),
});

// Schema frouxo usado SOMENTE sob `SKIP_ENV_VALIDATION=1` (isto é, durante
// `next build`, quando os segredos legitimamente não existem). Nada é
// obrigatório — mas os defaults do schema continuam valendo e o formato dos
// valores presentes ainda é conferido. Ausência é tolerada; lixo não é.
const looseEnvSchema = envSchema.partial().extend({ NODE_ENV: envSchema.shape.NODE_ENV });

export type Env = z.infer<typeof envSchema>;

/**
 * Ambiente possivelmente incompleto. É o que existe de fato quando a validação
 * é pulada: cada campo obrigatório pode simplesmente não ter sido definido.
 */
export type LooseEnv = z.infer<typeof looseEnvSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Configuração de ambiente inválida — ${issues}`);
  }
  return result.data;
}

export function parseLooseEnv(source: NodeJS.ProcessEnv): LooseEnv {
  return looseEnvSchema.parse(source);
}

// Valida no boot — o import acontece em `src/instrumentation.ts`, então um
// ambiente inválido lança antes de o servidor atender qualquer requisição.
// Pulado durante `next build` (SKIP_ENV_VALIDATION=1).
export const env: Env | LooseEnv =
  process.env.SKIP_ENV_VALIDATION === '1' ? parseLooseEnv(process.env) : parseEnv(process.env);
```

> **Nota de execução:** o plano original tipava o ramo do skip como
> `process.env as unknown as Env`. Isso era mentira em dois pontos: sob
> `SKIP_ENV_VALIDATION=1` cada campo é de fato `string | undefined` embora
> tipado como obrigatório, e o `.default()` de `NODE_ENV` nunca era aplicado
> (nenhum parse rodava). Trocado por um parse frouxo de verdade — daí
> `LooseEnv` e a união em `env`. Consequência deliberada: sob skip, um valor
> **presente** e malformado (p.ex. `NEXT_PUBLIC_SUPABASE_URL=nao-e-url`) passa a
> lançar; ausência continua tolerada, que é o único motivo de o skip existir.

- [ ] **Step 4: Criar `.env.example`**

```bash
NODE_ENV=development
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# Opcional (notificações do app)
SMTP_URL=smtp://user:pass@host:587
MAIL_FROM=crm@example.com
```

- [ ] **Step 5: Criar `src/instrumentation.ts`**

```ts
export async function register() {
  // Valida o ambiente no boot do servidor. Lança e impede o start se inválido.
  // O Next 15 engole a rejeição da promise devolvida por `register()`
  // (NextNodeServer.prepare().catch(...) em next-server.js) — sem o exit
  // explícito abaixo, o processo ficaria vivo respondendo 500 em toda
  // requisição, e um orquestrador (Docker/k8s/compose) veria um contêiner
  // "saudável" rodando um app quebrado. O process.exit(1) garante o sinal
  // certo: contêiner falho, não vivo servindo erro.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    await import('@/lib/env');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
```

> **Nota de execução:** ESTE step não existia no plano original — e sem ele a
> Task 6 inteira era código morto. `src/lib/env.ts` não era importado por
> nenhum módulo da aplicação (só pelo próprio teste), então `parseEnv` e a
> string `Configuração de ambiente inválida` sequer chegavam a `.next/server` /
> `.next/standalone`: o app subia feliz sem `SUPABASE_SERVICE_ROLE_KEY`,
> violando a Global Constraint “ambiente inválido deve lançar e impedir o
> start”. O hook `instrumentation` é estável no Next 15 e, com layout `src/`,
> mora em `src/instrumentation.ts` (nenhuma flag de config é necessária).
>
> Comportamento verificado no artefato de produção: sem env válido o servidor
> loga `Failed to prepare server … An error occurred while loading
> instrumentation hook: Configuração de ambiente inválida — …` e responde **500
> em toda requisição**; com env válido sobe limpo e serve 200.
>
> **Correção posterior (re-revisão focada):** o processo **não saía** —
> `NextNodeServer` engole a rejeição de `register()` via
> `this.prepare().catch(err => console.error('Failed to prepare server', err))`
> (`next-server.js:565-568` e `:975-982`), e `start-server.js:401` só chama
> `process.exit(1)` se `getRequestHandlers` lançar, o que não ocorre depois que
> a rejeição já foi engolida. Resultado: o socket ficava aberto, o servidor
> logava `Ready` e respondia 500 em 100% das requisições, mas o **processo
> continuava vivo** — um orquestrador (Docker/k8s/compose) via um contêiner
> "saudável" servindo um app quebrado. Substância da constraint cumprida (nenhum
> request é servido com sucesso), mas o sinal errado. Por isso `register()`
> agora envolve o `import('@/lib/env')` em `try/catch` e chama `process.exit(1)`
> no catch — não mais "trabalho futuro". O guard `NEXT_RUNTIME !== 'nodejs'`
> existe porque `process.exit` não existe no runtime edge; o sandbox edge do
> Next copia o `process.env` inteiro (`sandbox/context.js:100-110`), então o
> guard não vai barrar espuriamente o `middleware.ts` do Bloco 1 — ele só evita
> chamar `process.exit` num runtime que não o tem.
>
> Consequência operacional: o stage `runner` do Dockerfile (Task 14) **não**
> define `SKIP_ENV_VALIDATION`, então `docker run` sem variáveis de ambiente
> passa a falhar — isso é o comportamento correto. O smoke do contêiner precisa
> passar `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e
> `SUPABASE_SERVICE_ROLE_KEY`. `playwright.config.ts` (Task 5) já define
> `SKIP_ENV_VALIDATION=1` no `webServer.env`, que o Playwright **mescla** sobre
> `process.env`, então o e2e não é afetado.

- [ ] **Step 6: Rodar e ver passar**

Run: `npm run test -- env`
Expected: PASS (6 testes).

- [ ] **Step 7: Commit**

```bash
git add src/lib/env.ts src/instrumentation.ts .env.example tests/unit/env.test.ts
git commit -m "feat: validate environment at boot with zod"
```

---

## Task 7: Taxonomia de erros (TDD)

**Files:**
- Create: `src/lib/errors.ts`, `tests/unit/errors.test.ts`

**Interfaces:**
- Produces: `AppError` (base) + `ValidationError, UnauthenticatedError, UnauthorizedError, NotFoundError, ConflictError, BusinessRuleError, RateLimitError, IntegrationError, InternalError`. Cada um tem `code: string`, `category: ErrorCategory`, `httpStatus: number`, `message: string`, `cause?: unknown`, e método `toSafeJSON(): { code; message; category }` (nunca expõe stack/cause).

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/errors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InternalError,
} from '@/lib/errors';

describe('errors', () => {
  it('mapeia httpStatus por categoria', () => {
    expect(new ValidationError('x').httpStatus).toBe(422);
    expect(new NotFoundError('x').httpStatus).toBe(404);
    expect(new ConflictError('x').httpStatus).toBe(409);
    expect(new InternalError('x').httpStatus).toBe(500);
  });

  it('toSafeJSON não vaza cause nem stack', () => {
    const err = new InternalError('boom', { cause: new Error('db senha=123') });
    const safe = err.toSafeJSON();
    expect(safe).toEqual({ code: 'INTERNAL', category: 'internal', message: 'boom' });
    expect(JSON.stringify(safe)).not.toContain('senha');
  });

  it('são instâncias de AppError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- errors`
Expected: FAIL ("Cannot find module '@/lib/errors'").

- [ ] **Step 3: Implementar `src/lib/errors.ts`**

```ts
export type ErrorCategory =
  | 'validation'
  | 'unauthenticated'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'business_rule'
  | 'rate_limit'
  | 'integration'
  | 'internal';

interface AppErrorOptions {
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  abstract readonly httpStatus: number;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }

  toSafeJSON(): { code: string; category: ErrorCategory; message: string } {
    return { code: this.code, category: this.category, message: this.message };
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION';
  readonly category = 'validation' as const;
  readonly httpStatus = 422;
}
export class UnauthenticatedError extends AppError {
  readonly code = 'UNAUTHENTICATED';
  readonly category = 'unauthenticated' as const;
  readonly httpStatus = 401;
}
export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly category = 'unauthorized' as const;
  readonly httpStatus = 403;
}
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly category = 'not_found' as const;
  readonly httpStatus = 404;
}
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  readonly category = 'conflict' as const;
  readonly httpStatus = 409;
}
export class BusinessRuleError extends AppError {
  readonly code = 'BUSINESS_RULE';
  readonly category = 'business_rule' as const;
  readonly httpStatus = 422;
}
export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMIT';
  readonly category = 'rate_limit' as const;
  readonly httpStatus = 429;
}
export class IntegrationError extends AppError {
  readonly code = 'INTEGRATION';
  readonly category = 'integration' as const;
  readonly httpStatus = 502;
}
export class InternalError extends AppError {
  readonly code = 'INTERNAL';
  readonly category = 'internal' as const;
  readonly httpStatus = 500;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test -- errors`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors.ts tests/unit/errors.test.ts
git commit -m "feat: add error taxonomy (safe json, http mapping)"
```

---

## Task 8: Logger estruturado + correlação + redação (TDD)

**Files:**
- Create: `src/lib/logger.ts`, `tests/unit/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(destination?: pino.DestinationStream): Logger` e `logger` (default). `Logger` tem `.info/.warn/.error/.debug` (pino) e `withCorrelation(id: string): Logger`. Campos sensíveis são redigidos como `[REDACTED]`, em qualquer profundidade e ignorando capitalização: `password`, `senha`, `token`, `access_token`, `refresh_token`, `accessToken`, `refreshToken`, `authorization`, `apiKey`/`api_key`, `secret`, `client_secret`, `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, `cpf`, `passaporte`, `passport`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/logger.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '@/lib/logger';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').trim().split('\n').map((l) => JSON.parse(l)) };
}

describe('logger', () => {
  it('redige campos sensíveis', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info({ password: 'segredo', cpf: '12345678900', ok: 1 }, 'evento');
    const [entry] = lines();
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.cpf).toBe('[REDACTED]');
    expect(entry.ok).toBe(1);
  });

  it('redige os campos de uma sessão do Supabase Auth', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        access_token: 'eyJhbGciOi.SEGREDO',
        refresh_token: 'rt-SEGREDO',
        accessToken: 'camelCase-SEGREDO',
        apiKey: 'ak-SEGREDO',
        senha: 'minha-senha',
        expires_in: 3600,
      },
      'sessão',
    );
    const [entry] = lines();
    expect(entry!.access_token).toBe('[REDACTED]');
    expect(entry!.refresh_token).toBe('[REDACTED]');
    expect(entry!.accessToken).toBe('[REDACTED]');
    expect(entry!.apiKey).toBe('[REDACTED]');
    expect(entry!.senha).toBe('[REDACTED]');
    expect(entry!.expires_in).toBe(3600);
    expect(JSON.stringify(entry)).not.toContain('SEGREDO');
    expect(JSON.stringify(entry)).not.toContain('minha-senha');
  });

  it('redige em profundidade arbitrária e ignorando capitalização', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.info(
      {
        session: {
          access_token: 'nivel-2-SEGREDO',
          user: { id: 'u1', cpf: '12345678900', Authorization: 'Bearer SEGREDO' },
        },
        req: { headers: { Authorization: 'Bearer SEGREDO' } },
        env: { SUPABASE_SERVICE_ROLE_KEY: 'srk-SEGREDO' },
        lista: [{ deep: { passport: 'AB123456' } }],
      },
      'aninhado',
    );
    const [entry] = lines();
    const session = entry!.session as Record<string, unknown>;
    const user = session.user as Record<string, unknown>;
    expect(session.access_token).toBe('[REDACTED]');
    expect(user.cpf).toBe('[REDACTED]');
    expect(user.Authorization).toBe('[REDACTED]');
    expect(user.id).toBe('u1');
    expect(
      ((entry!.req as Record<string, unknown>).headers as Record<string, unknown>)!.Authorization,
    ).toBe('[REDACTED]');
    expect((entry!.env as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('SEGREDO');
    expect(JSON.stringify(entry)).not.toContain('AB123456');
  });

  it('preserva o serializer de Error do pino', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream);
    log.error({ err: new Error('falhou feio') }, 'erro');
    const [entry] = lines();
    expect((entry!.err as Record<string, unknown>).message).toBe('falhou feio');
    expect((entry!.err as Record<string, unknown>).type).toBe('Error');
  });

  it('inclui correlationId via withCorrelation', () => {
    const { stream, lines } = capture();
    const log = createLogger(stream).withCorrelation('req-123');
    log.info('oi');
    expect(lines()[0]!.correlationId).toBe('req-123');
  });
});
```

> **Nota de execução:** os índices ganharam `!` (`entry!`, `lines()[0]!`) por
> causa de `noUncheckedIndexedAccess`; nenhuma asserção foi enfraquecida.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- logger`
Expected: FAIL ("Cannot find module '@/lib/logger'").

- [ ] **Step 3: Implementar `src/lib/logger.ts`**

```ts
import pino from 'pino';

/**
 * Nomes de campo que nunca podem ir para o log. A lista traz as variantes de
 * capitalização/grafia que este stack realmente produz — os `paths` do pino são
 * literais e case-sensitive, então `access_token` e `accessToken` são entradas
 * distintas. `access_token`/`refresh_token` são os nomes exatos dentro de uma
 * sessão do Supabase Auth.
 */
const REDACT_FIELDS = [
  'password',
  'senha',
  'token',
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'authorization',
  'Authorization',
  'apiKey',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'service_role',
  'SUPABASE_SERVICE_ROLE_KEY',
  'cpf',
  'passaporte',
  'passport',
];

const CENSOR = '[REDACTED]';

/** Redação nativa do pino: cobre o nível raiz e um nível de aninhamento. */
const REDACT_PATHS = REDACT_FIELDS.flatMap((field) => [field, `*.${field}`]);

/** Mesma lista, normalizada, para a varredura recursiva (case-insensitive). */
const SENSITIVE_KEYS = new Set(REDACT_FIELDS.map((field) => field.toLowerCase()));

/** Objetos mais fundos que isto passam intactos — guarda contra logs patológicos. */
const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = value.map((item) => redactValue(item, seen, depth + 1));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out = redactObject(value, seen, depth);
  seen.delete(value);
  return out;
}

function redactObject(
  obj: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? CENSOR : redactValue(value, seen, depth + 1);
  }
  return out;
}

/**
 * O `redact` do pino (fast-redact) só entende curinga de UM nível (`*.campo`):
 * não existe `**`, então `session.user.cpf` escaparia. Um `censor` também não
 * resolve — ele só decide o valor de um path já casado, não descobre paths
 * novos. Por isso a varredura própria em `formatters.log`, que roda antes dos
 * stringifiers de redação (pino/lib/tools.js `_asJson`) e cobre profundidade
 * arbitrária e qualquer capitalização.
 *
 * O `redact` nativo continua ativo porque ele — e não `formatters.log` — é o
 * que alcança os bindings de `child()` (`asChindings`), usados por
 * `withCorrelation`. Os dois são idempotentes entre si.
 *
 * A varredura só desce em objetos literais e arrays: Error, Date, Buffer e
 * instâncias de classe passam por referência, para não quebrar os serializers
 * do pino (o `err` serializer, em particular).
 */
function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  seen.add(obj);
  return redactObject(obj, seen, 0);
}

export interface Logger extends pino.Logger {
  withCorrelation(id: string): Logger;
}

export function createLogger(destination?: pino.DestinationStream): Logger {
  const base = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: CENSOR },
      formatters: { log: redactLogObject },
    },
    destination,
  );
  return attach(base);
}

function attach(instance: pino.Logger): Logger {
  const logger = instance as Logger;
  logger.withCorrelation = (id: string) => attach(instance.child({ correlationId: id }));
  return logger;
}

export const logger = createLogger();
```

> **Nota de execução:** a lista original do plano (`password, token,
> authorization, service_role, cpf, passaporte, secret`) vazava exatamente os
> nomes que este stack produz. Os `paths` do pino são literais e
> case-sensitive, então `access_token`, `refresh_token`, `accessToken`,
> `apiKey`, `Authorization` (maiúsculo), `SUPABASE_SERVICE_ROLE_KEY`,
> `passport` e `senha` passavam batido — e `access_token`/`refresh_token` são
> os nomes exatos de toda sessão do Supabase Auth, com o Bloco 1 sendo auth.
> Além disso o `redact` do pino (fast-redact) só entende curinga de UM nível
> (`*.campo`): não existe `**`, e um `censor` não ajuda porque ele só decide o
> valor de um path já casado. Por isso a varredura recursiva em
> `formatters.log` — que roda ANTES dos stringifiers de redação
> (`pino/lib/tools.js`, `_asJson`) — mantendo o `redact` nativo, que é o único
> que alcança os bindings de `child()` usados por `withCorrelation`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run test -- logger`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/logger.ts tests/unit/logger.test.ts
git commit -m "feat: add structured logger with redaction + correlation"
```

---

## Task 9: Dois clients Supabase (D4) + config testável

**Files:**
- Create: `src/lib/supabase/config.ts`, `src/lib/supabase/user-client.ts`, `src/lib/supabase/service-client.ts`, `src/lib/supabase/README.md`, `tests/unit/supabase-config.test.ts`

**Interfaces:**
- Consumes: `env` de `@/lib/env`.
- Produces:
  - `getUserSupabaseConfig(): { url: string; anonKey: string }`
  - `getServiceSupabaseConfig(): { url: string; serviceRoleKey: string }` (lança se faltar service role)
  - `createUserClient(): SupabaseClient` (JWT do usuário via cookies — RLS aplicada)
  - `createServiceClient(): SupabaseClient` (service_role; `server-only`; sem sessão persistida)

- [ ] **Step 1: Escrever o teste que falha (só a config, que é pura)**

`tests/unit/supabase-config.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('supabase config', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SKIP_ENV_VALIDATION = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  });

  it('config de usuário usa url + anon key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    const { getUserSupabaseConfig } = await import('@/lib/supabase/config');
    expect(getUserSupabaseConfig()).toEqual({ url: 'https://abc.supabase.co', anonKey: 'anon' });
  });

  it('config de serviço lança sem service role', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getServiceSupabaseConfig } = await import('@/lib/supabase/config');
    expect(() => getServiceSupabaseConfig()).toThrow(/service role/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- supabase-config`
Expected: FAIL ("Cannot find module '@/lib/supabase/config'").

- [ ] **Step 3: Implementar `src/lib/supabase/config.ts`**

```ts
export function getUserSupabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Config Supabase de usuário ausente (url/anon key)');
  return { url, anonKey };
}

export function getServiceSupabaseConfig(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Config Supabase de serviço (service role) ausente');
  return { url, serviceRoleKey };
}
```

- [ ] **Step 4: Implementar `src/lib/supabase/user-client.ts`**

```ts
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from './config';

// Client por-requisição com o JWT/sessão do usuário → RLS é aplicada de fato (D4).
export async function createUserClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getUserSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Chamado de um Server Component: ignorável se o middleware renova a sessão.
          // (padrão recomendado por @supabase/ssr)
        }
      },
    },
  });
}
```

- [ ] **Step 5: Implementar `src/lib/supabase/service-client.ts`**

```ts
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServiceSupabaseConfig } from './config';

// SÓ para rotinas de sistema (webhook, cron, ETL, plataforma). Nunca em request de usuário. RLS é IGNORADA.
export function createServiceClient(): SupabaseClient {
  const { url, serviceRoleKey } = getServiceSupabaseConfig();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

- [ ] **Step 6: Documentar em `src/lib/supabase/README.md`**

```markdown
# Clients Supabase (decisão D4)

- `createUserClient()` — client por-requisição com o JWT do usuário (via cookies). **Padrão** para
  toda leitura/escrita de dados de tenant. A RLS do banco é aplicada.
- `createServiceClient()` — client `service_role`, marcado `server-only`. **RLS é ignorada.** Usar
  APENAS em webhook do WhatsApp, jobs de cron, ETL de migração e operações de plataforma.
  Funções `SECURITY DEFINER` chamadas com qualquer client re-checam permissão internamente (H2).

Nunca importar `service-client.ts` em componentes de cliente. Nunca expor `SUPABASE_SERVICE_ROLE_KEY`.
```

- [ ] **Step 7: Rodar e ver passar; typecheck**

Run: `npm run test -- supabase-config && npm run typecheck`
Expected: PASS (2 testes) e typecheck OK.

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase tests/unit/supabase-config.test.ts
git commit -m "feat: add isolated supabase user + service clients (D4)"
```

---

## Task 10: Mailer desacoplado (TDD)

**Files:**
- Create: `src/lib/mailer/index.ts`, `tests/unit/mailer.test.ts`

**Interfaces:**
- Produces:
  - `type MailMessage = { to: string; subject: string; text: string; html?: string; from?: string }`
  - `type MailResult = { id: string }`
  - `interface Mailer { send(msg: MailMessage): Promise<MailResult> }`
  - `class DevMailer implements Mailer` com propriedade `sent: MailMessage[]`
  - `class SmtpMailer implements Mailer` (usa `nodemailer` + `SMTP_URL`/`MAIL_FROM`)

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/mailer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DevMailer } from '@/lib/mailer';

describe('DevMailer', () => {
  it('registra as mensagens enviadas e devolve id', async () => {
    const mailer = new DevMailer();
    const res = await mailer.send({ to: 'a@b.com', subject: 'oi', text: 'corpo' });
    expect(res.id).toMatch(/^dev-/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('a@b.com');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- mailer`
Expected: FAIL ("Cannot find module '@/lib/mailer'").

- [ ] **Step 3: Implementar `src/lib/mailer/index.ts`**

```ts
import nodemailer from 'nodemailer';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};
export type MailResult = { id: string };

export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
}

// Impl de desenvolvimento/teste: não envia nada, só registra.
export class DevMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private seq = 0;
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    this.seq += 1;
    return { id: `dev-${this.seq}` };
  }
}

// Impl SMTP para produção (Resend/qualquer SMTP). Config via SMTP_URL + MAIL_FROM.
export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;

  constructor(
    smtpUrl: string,
    private readonly defaultFrom: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const info = await this.transport.sendMail({
      from: msg.from ?? this.defaultFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { id: info.messageId };
  }
}
```

> **Nota de execução:** a versão original deste bloco atribuía `transport`
> via inicializador de campo lendo `this.smtpUrl` (uma parameter property),
> o que sob `target: "ES2022"` deste repositório (`useDefineForClassFields`
> implícito) roda **antes** da atribuição da parameter property no corpo do
> construtor — `npm run typecheck` falhava com `TS2729` e, em runtime, o
> transport era construído com `undefined`. Corrigido movendo a atribuição
> para o corpo do construtor, usando o parâmetro local `smtpUrl` (que não
> precisa mais ser guardado como campo). Ver `task-10-report.md`.

- [ ] **Step 4: Rodar e ver passar; typecheck**

Run: `npm run test -- mailer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailer tests/unit/mailer.test.ts
git commit -m "feat: add decoupled mailer (dev + smtp)"
```

---

## Task 11: Rate limiter desacoplado + migração Postgres (TDD)

**Files:**
- Create: `src/lib/rate-limit/index.ts`, `tests/unit/rate-limit.test.ts`, `supabase/migrations/0002_rate_limit.sql`

**Interfaces:**
- Produces:
  - `type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date }`
  - `interface RateLimiter { check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> }`
  - `class InMemoryRateLimiter implements RateLimiter` (com injeção de relógio `now: () => number`)
  - `class PostgresRateLimiter implements RateLimiter` (chama RPC `rate_limit_hit`)

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/rate-limit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { InMemoryRateLimiter } from '@/lib/rate-limit';

describe('InMemoryRateLimiter', () => {
  it('permite até o limite e bloqueia depois, dentro da janela', async () => {
    let t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    expect((await rl.check('k', 2, 60)).allowed).toBe(true);
    expect((await rl.check('k', 2, 60)).allowed).toBe(true);
    const third = await rl.check('k', 2, 60);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('reseta após a janela', async () => {
    let t = 1_000_000;
    const rl = new InMemoryRateLimiter(() => t);
    await rl.check('k', 1, 60);
    expect((await rl.check('k', 1, 60)).allowed).toBe(false);
    t += 61_000;
    expect((await rl.check('k', 1, 60)).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm run test -- rate-limit`
Expected: FAIL ("Cannot find module '@/lib/rate-limit'").

- [ ] **Step 3: Implementar `src/lib/rate-limit/index.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

// Chamadas a cada N `check()` disparam a varredura de buckets expirados do
// InMemoryRateLimiter (custo O(n) amortizado sobre N chamadas, em vez de
// O(n) a cada chamada ou vazamento indefinido de memória).
export const RATE_LIMIT_SWEEP_INTERVAL = 128;

export interface RateLimiter {
  /**
   * Contrato: uma chamada bloqueada ainda consome orçamento da janela atual,
   * até um ponto de saturação de `limit + 1` (o contador não cresce sem
   * limite) — e nunca estende `resetAt`; o fim da janela é fixado na
   * primeira chamada que a abre.
   */
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  private checksSinceSweep = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Exposto só para inspeção em teste da varredura; não é uma API de eviction. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const t = this.now();
    this.sweepExpired(t);
    const existing = this.buckets.get(key);
    let bucket = existing;
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count <= limit) bucket.count += 1; // satura em limit + 1
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(limit - bucket.count, 0),
      resetAt: new Date(bucket.resetAt),
    };
  }

  private sweepExpired(t: number): void {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < RATE_LIMIT_SWEEP_INTERVAL) return;
    this.checksSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key);
    }
  }
}

type RateLimitHitRow = { allowed: boolean; remaining: number; reset_at: string };

/**
 * Implementação Postgres via RPC `rate_limit_hit` (ver
 * `supabase/migrations/0002_rate_limit.sql`). A tabela `rate_limit_counters`
 * tem RLS habilitada e sem policies, com grants revogados de `anon` e
 * `authenticated` — só um client `service_role` consegue gravar/ler os
 * contadores. Por isso este construtor DEVE receber um client criado por
 * `createServiceClient()` (`@/lib/supabase/service-client`, D4); nunca um
 * client de usuário.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly client: SupabaseClient) {}
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const { data, error } = await this.client.rpc('rate_limit_hit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    const rows: RateLimitHitRow[] | RateLimitHitRow | null = data;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error('rate_limit_hit não retornou linha');
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: new Date(row.reset_at),
    };
  }
}
```

> **Nota de execução:** a review pós-implementação (findings 2 e 3) apontou
> que `SupabaseClient<Database = any>` colapsa o retorno do `rpc()` para
> `any`, então `noUncheckedIndexedAccess` nunca chegava a atuar em `row` —
> uma renomeação de coluna no SQL compilaria e só quebraria em runtime como
> `Invalid Date`. Corrigido anotando `data` com um tipo `RateLimitHitRow`
> explícito antes de indexar, e lançando se a linha vier vazia (sem `any`,
> sem non-null assertion). A review também apontou que `InMemoryRateLimiter`
> (bloqueia sem incrementar) e `rate_limit_hit` (sempre incrementa) discordam
> sobre `allowed`/`remaining` quando `limit` varia entre chamadas para a
> mesma chave/janela; ambos foram trazidos a um contrato comum de saturação
> em `limit + 1` (ver `RateLimiter.check`) e ganharam um teste cobrindo
> limite variável. `InMemoryRateLimiter` também ganhou varredura amortizada
> de buckets expirados (a cada `RATE_LIMIT_SWEEP_INTERVAL` chamadas) — os
> buckets nunca eram removidos, e as chaves vêm de input do atacante (IP/
> e-mail). Ver `task-11-report.md`.

- [ ] **Step 4: Criar a migração `supabase/migrations/0002_rate_limit.sql`**

```sql
create table if not exists public.rate_limit_counters (
  key         text primary key,
  count       integer not null default 0,
  reset_at    timestamptz not null
);

comment on table public.rate_limit_counters is 'Contadores atômicos de rate limiting (fallback sem Redis).';

-- Infraestrutura, não tabela de negócio: fica exposta por padrão no schema
-- `public` do PostgREST, então precisa de RLS mesmo sem policies de tenant.
-- Sem isso, qualquer holder de anon key apaga/zera os próprios contadores.
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

-- O default ACL deste schema concede às roles do Supabase apenas `Dxtm`
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) — nunca DML. Como `rate_limit_hit` é
-- SECURITY INVOKER e BYPASSRLS não substitui um GRANT ausente, sem esta linha o
-- PostgresRateLimiter falha com "permission denied for table" em toda chamada.
grant select, insert, update, delete on public.rate_limit_counters to service_role;

create index if not exists rate_limit_counters_reset_at_idx
  on public.rate_limit_counters (reset_at);

create or replace function public.rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_reset timestamptz;
begin
  insert into public.rate_limit_counters as c (key, count, reset_at)
    values (p_key, 1, v_now + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set count = case
          when c.reset_at <= v_now then 1
          when c.count <= p_limit then c.count + 1
          else c.count   -- satura em p_limit + 1
        end,
        reset_at = case when c.reset_at <= v_now
                        then v_now + make_interval(secs => p_window_seconds)
                        else c.reset_at end
  returning c.count, c.reset_at into v_count, v_reset;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);
  reset_at := v_reset;
  return next;
end;
$$;
```

> **Nota de execução:** a review pós-implementação (finding 1, CRITICAL)
> apontou que `rate_limit_counters` ficava exposta pelo PostgREST sem RLS —
> qualquer holder de anon key conseguiria apagar/zerar os próprios
> contadores. Adicionado `alter table ... enable row level security` +
> `revoke all ... from anon, authenticated` (sem policies; só `service_role`
> acessa, então `PostgresRateLimiter` exige um client de
> `createServiceClient()`, D4) e `set search_path = pg_catalog, public` na
> função (linter do Supabase acusa `function_search_path_mutable`). O
> finding 3 trouxe `rate_limit_hit` ao mesmo contrato de saturação em
> `limit + 1` do `InMemoryRateLimiter` (`count` para de crescer quando já
> passou de `p_limit`, em vez de crescer sem limite). O finding 4 adicionou
> `create index ... on rate_limit_counters (reset_at)` para dar suporte a
> uma varredura periódica futura (por `pg_cron`, fora do Bloco 0) — nenhuma
> `delete` foi adicionada nesta migração. Ver `task-11-report.md`.
>
> A revisão final do bloco acrescentou o `grant select, insert, update, delete
> … to service_role`. O `revoke` acima removia apenas o que o default ACL desta
> imagem do Supabase concede a `anon`/`authenticated`, que é só `Dxtm`
> (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) — DML nunca foi concedido a ninguém,
> nem a `service_role`. Como `rate_limit_hit` é SECURITY INVOKER e `BYPASSRLS`
> não substitui um GRANT ausente, o `PostgresRateLimiter` falhava com
> `permission denied for table rate_limit_counters` em **toda** chamada.
> Reproduzido executando a RPC como `service_role` no banco local; o defeito era
> dependente de ambiente (um projeto hospedado mais permissivo funcionaria).
> O `revoke` continua no lugar por ser load-bearing nesses projetos permissivos.

- [ ] **Step 5: Rodar e ver passar; typecheck**

Run: `npm run test -- rate-limit && npm run typecheck`
Expected: PASS (2 testes). (A migração é validada na Task 12.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/rate-limit supabase/migrations/0002_rate_limit.sql tests/unit/rate-limit.test.ts
git commit -m "feat: add decoupled rate limiter (in-memory + postgres rpc)"
```

---

## Task 12: Supabase local + migrations + pgTAP smoke

**Files:**
- Create: `supabase/config.toml` (via CLI), `supabase/migrations/0001_extensions.sql`, `supabase/tests/00_smoke.test.sql`
- Nota: `0002_rate_limit.sql` já existe (Task 11).

**Interfaces:**
- Produces: pipeline de migrations aplicável localmente (`supabase db reset`) e harness de teste pgTAP (`supabase test db`).

- [ ] **Step 1: Inicializar o Supabase local (requer Docker Desktop rodando)**

Run: `npx supabase init`
Expected: cria `supabase/config.toml` e a pasta `supabase/`.

- [ ] **Step 2: Criar `supabase/migrations/0001_extensions.sql`**

```sql
-- Extensões usadas pelo projeto.
create extension if not exists pgcrypto;   -- gen_random_uuid(), digest() para hash de documento
```

- [ ] **Step 3: Criar o smoke pgTAP `supabase/tests/00_smoke.test.sql`**

```sql
begin;
select plan(7);

select has_table('public', 'rate_limit_counters', 'rate_limit_counters existe');
select has_function('public', 'rate_limit_hit', 'função rate_limit_hit existe');

-- Existência não basta: o default ACL do schema `public` não concede DML às
-- roles do Supabase, e `rate_limit_hit` é SECURITY INVOKER. Só executando a RPC
-- sob a role real dá para provar que o GRANT da migração 0002 está em vigor.
create temporary table rl_probe (step integer, allowed boolean, remaining integer);
grant insert on rl_probe to service_role;

set local role service_role;
insert into rl_probe select 1, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
insert into rl_probe select 2, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
insert into rl_probe select 3, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
reset role;

select is(
  (select allowed from rl_probe where step = 1),
  true,
  'service_role: 1ª chamada dentro do limite é permitida'
);
select is(
  (select remaining from rl_probe where step = 2),
  0,
  'service_role: 2ª chamada esgota a cota (remaining = 0)'
);
select is(
  (select allowed from rl_probe where step = 3),
  false,
  'service_role: 3ª chamada excede o limite e é bloqueada'
);
select is(
  (select c.count from public.rate_limit_counters c where c.key = 'pgtap:svc'),
  3,
  'contador satura em p_limit + 1 (não cresce indefinidamente)'
);

-- A correção não pode ter aberto a tabela para o resto do mundo: `anon` ainda
-- precisa falhar fechado ao chamar a RPC (EXECUTE é público, o DML não).
set local role anon;
select throws_ok(
  $$ select * from public.rate_limit_hit('pgtap:anon', 2, 60) $$,
  '42501',
  null,
  'anon continua sem DML na tabela (falha fechado)'
);
reset role;

select * from finish();
rollback;
```

> **Nota de execução:** o smoke original só tinha `has_table`/`has_function`.
> Asserções de existência jamais pegariam o defeito Critical da revisão final
> (o `service_role` sem DML na tabela), porque a tabela e a função existiam.
> O smoke agora EXECUTA a RPC sob `set local role service_role` e confere a
> semântica real (permitido dentro do limite, bloqueado ao exceder, contador
> saturando em `p_limit + 1`), e confere que `anon` continua levando `42501`
> — ou seja, que a correção falha fechado. As chamadas ficam dentro de um
> `insert ... select` numa temp table para que só elas rodem sob a role trocada:
> as próprias funções do pgTAP continuam sendo chamadas como `postgres`.
> `plan(2)` virou `plan(7)`.

- [ ] **Step 4: Subir o banco e aplicar migrations**

Run: `npx supabase start && npm run db:reset`
Expected: containers sobem; migrations `0001` e `0002` aplicam sem erro.

- [ ] **Step 5: Rodar os testes pgTAP**

Run: `npm run db:test`
Expected: PASS (7 asserts do smoke).

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml supabase/migrations/0001_extensions.sql supabase/tests/00_smoke.test.sql
git commit -m "chore: init supabase local + extensions migration + pgtap smoke"
```

---

## Task 13: CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: pipeline que roda em push/PR, em três jobs paralelos: `build` (install → lint → typecheck → unit tests → build), `db` (supabase start → pgTAP) e `e2e` (playwright).

- [ ] **Step 1: Criar `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
        env:
          SKIP_ENV_VALIDATION: '1'

  # pgTAP precisa de um Postgres com as migrations aplicadas. `supabase start`
  # sobe o stack e roda as migrations; a CLI vem da action oficial, então este
  # job não precisa de Node nem de `npm ci`.
  db:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: 2.109.1
      - run: supabase start
      - run: supabase test db
      - name: Parar o stack
        if: always()
        run: supabase stop --no-backup

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      # `playwright.config.ts` sobe o servidor (webServer) já com
      # SKIP_ENV_VALIDATION=1, então não é preciso ambiente Supabase aqui.
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

> **Nota de execução:** a versão original deste bloco definia
> `SKIP_ENV_VALIDATION: '1'` no nível do `job`, aplicando o bypass a
> `npm ci`, `lint`, `typecheck` e `test`, não só a `build`. O Global
> Constraint do plano já dizia que a validação é pulada "exceto durante
> `next build`" — a review pós-implementação apontou a divergência: hoje é
> inerte (nenhum teste importa o singleton `env` no escopo do módulo), mas é
> uma armadilha latente — se um teste futuro importar `env` no topo do
> arquivo, o CI silenciosamente pararia de validá-lo. Corrigido movendo
> `env: SKIP_ENV_VALIDATION: '1'` para o passo `npm run build`
> especificamente. Ver `task-13-report.md`.
>
> A revisão final do bloco acrescentou os jobs `db` e `e2e`. Antes deles,
> `tests/e2e/home.spec.ts` e `supabase/tests/00_smoke.test.sql` não tinham
> nenhuma verificação automatizada — só rodavam à mão. Jobs separados (em vez
> de um job longo) mantêm o feedback rápido do `build` e deixam claro qual
> camada quebrou. O job `db` não precisa de Node: `supabase/setup-cli` traz a
> CLI (pinada na mesma versão do devDependency) e `supabase start` já aplica
> as migrations, então `supabase test db` é exatamente o que `npm run db:test`
> roda localmente. O job `e2e` instala só o chromium; o `webServer` do
> `playwright.config.ts` já define `SKIP_ENV_VALIDATION=1` e o Playwright
> MESCLA esse `env` sobre `process.env` (verificado em
> `playwright/lib/runner/index.js`), então nenhum ambiente Supabase é
> necessário ali. ATENÇÃO: este workflow nunca executou no GitHub Actions —
> o YAML foi validado sintaticamente e os comandos são os provados
> localmente, mas a resolução das actions em runners reais continua em aberto.

- [ ] **Step 2: Verificar localmente a mesma sequência**

Run: `npm ci && npm run lint && npm run typecheck && npm run test && SKIP_ENV_VALIDATION=1 npm run build`
Expected: todos PASS.

- [ ] **Step 3: Commit e push (dispara o CI)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/typecheck/test/build workflow"
git push origin main
```

Expected: o workflow "CI" fica verde no GitHub (aba Actions).

> **Nota de execução:** para esta execução (Bloco 0, branch
> `bloco-0-fundacao`), o push para `main` no Step 3 foi propositalmente
> sobrescrito por decisão humana — apenas o commit local foi feito. A
> integração com `main` é decidida separadamente, ao final do bloco, para
> preservar o isolamento de branch usado em toda esta rodada. O workflow só
> vai rodar de fato no GitHub quando a branch for integrada. Ver
> `task-13-report.md`.

---

## Task 14: Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces: imagem de produção Next.js (standalone) construível.

- [ ] **Step 1: Criar `.dockerignore`**

```
node_modules
.next
.git
docs
Arte
tests
*.md
.env*
!.env.example
```

> **Nota de execução:** a review pós-implementação (Important) apontou que
> `Dockerfile` faz `COPY . .` no estágio `builder` (Step 2) sem o
> `.dockerignore` excluir `.env*` — e `.env.example` documenta
> `SUPABASE_SERVICE_ROLE_KEY`, então o caminho de onboarding padrão
> (`cp .env.example .env`) colocaria o segredo mais sensível do projeto,
> sem exclusão, no contexto de build. A imagem final não carrega esse
> arquivo adiante, mas o layer do `builder` carrega, e esse layer persiste
> no cache de build. Adicionado `.env*` com negação `!.env.example` (mantém
> o template disponível no contexto; exclui qualquer `.env`/`.env.local`
> real). Ver `task-14-report.md`.

- [ ] **Step 2: Criar `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Construir a imagem**

Run: `docker build -t crm-listener:dev .`
Expected: build conclui; imagem criada.

- [ ] **Step 3b: Smoke do contêiner (nos dois sentidos)**

```bash
# NEGATIVO — sem variáveis de ambiente o app não deve servir.
docker run --rm -d --name crm-smoke-noenv -p 3200:3000 crm-listener:dev
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/   # espera 500
docker logs crm-smoke-noenv                                        # espera o erro de instrumentation
docker rm -f crm-smoke-noenv

# POSITIVO — com env dummy o app serve a home.
docker run --rm -d --name crm-smoke-env -p 3200:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://dummy.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy-anon \
  -e SUPABASE_SERVICE_ROLE_KEY=dummy-service \
  crm-listener:dev
curl -s http://127.0.0.1:3200/   # espera 200 com "CRM Rádios — Fundação OK" e "Começar"
docker rm -f crm-smoke-env
```

> **Nota de execução:** o stage `runner` deliberadamente NÃO define
> `SKIP_ENV_VALIDATION` — só o `builder` define, para o `next build`. Depois
> que a Task 6 passou a validar o ambiente no boot (via
> `src/instrumentation.ts`), `docker run` sem variáveis passou a falhar, e isso
> é o resultado desejado: é a prova ponta a ponta, dentro do artefato, de que a
> Global Constraint “ambiente inválido impede o start” vale de fato. Por isso o
> smoke tem de rodar nos dois sentidos. Detalhe honesto: no caso negativo o
> processo não morre — ele mantém o socket aberto e responde 500 em todas as
> requisições.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "chore: add production dockerfile (next standalone)"
```

---

## Definition of Done (Bloco 0)

- [ ] App sobe local (`npm run dev`) e o CI está verde.
- [ ] `npm run lint`, `npm run typecheck` e `npm run test` passam.
- [ ] Ambiente inválido barra o boot — comprovado pelo teste de `parseEnv`, pelo teste de throw-no-import e, ponta a ponta, pelo contêiner sem env respondendo 500 com o erro de instrumentation.
- [ ] Dois clients Supabase documentados e isolados (`service-client` marcado `server-only`).
- [ ] `supabase db reset` aplica migrations e `supabase test db` passa (pgTAP smoke, com a RPC EXECUTADA como `service_role`).
- [ ] `docker build` conclui e o contêiner serve a home com env válido (e falha sem env).
- [ ] `npm run test:e2e` passa.

---

## Self-Review (cobertura do Bloco 0 vs. spec)

- **Next.js App Router + TS strict** → Task 1. ✅
- **Tailwind + shadcn/ui (sem Bootstrap)** → Task 3. ✅
- **Zod, RHF, TanStack, Recharts, ExcelJS, @react-pdf/renderer** → Zod (Task 6). *RHF/TanStack/Recharts/ExcelJS/@react-pdf são instalados sob demanda no primeiro bloco que os usa (Bloco 1/2/8) — YAGNI; anotado aqui para não serem esquecidos.*
- **Vitest + Playwright + pgTAP (N9)** → Tasks 4, 5, 12. ✅
- **Mailer SMTP/Resend (N10)** → Task 10. ✅
- **Rate limit + `rate_limit_counters` (N6)** → Task 11. ✅
- **Supabase CLI + migrations** → Task 12. ✅
- **Validação de env no boot** → Task 6. ✅
- **Dois clients Supabase (D4)** → Task 9. ✅
- **Taxonomia de erros (§25)** → Task 7. ✅
- **Logs estruturados + correlação + redação (§31)** → Task 8. ✅
- **CI** → Task 13. ✅
- **Dockerfile** → Task 14. ✅

**Fora do Bloco 0 (por design):** tabelas de negócio, RLS, auth, `pg_cron` (habilitado no bloco que usa cron), `outbox`/`webhook_events`/`audit_logs`/`idempotency_keys` (criados nos blocos que os consomem). Sem placeholders pendentes neste plano.
