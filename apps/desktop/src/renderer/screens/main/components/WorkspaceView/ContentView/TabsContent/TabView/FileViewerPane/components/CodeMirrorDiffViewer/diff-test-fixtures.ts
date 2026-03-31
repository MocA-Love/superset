/**
 * Test fixtures for CodeMirrorDiffViewer — covers all diff patterns.
 * Use these in the Electron renderer console or a dedicated test page:
 *
 *   import { diffFixtures } from "./diff-test-fixtures";
 *   // then render <CodeMirrorDiffViewer original={diffFixtures.foo.original} modified={diffFixtures.foo.modified} ... />
 */

export interface DiffFixture {
	label: string;
	description: string;
	language: string;
	original: string;
	modified: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const lines = (...ls: string[]) => ls.join("\n");

// ── fixtures ─────────────────────────────────────────────────────────────────

/** 1. Pure insertion — b has lines that a does not */
const pureInsertion: DiffFixture = {
	label: "pure-insertion",
	description:
		"Lines added to b only. Should show green line bg only, no inline highlight.",
	language: "typescript",
	original: lines(
		"function greet(name: string) {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  return `Hello, ${name}!`;",
		"}",
	),
	modified: lines(
		"function greet(name: string) {",
		"  // Added comment",
		"  const prefix = 'Hello';",
		`  return \`\${prefix}, \${name}!\`;`,
		"}",
	),
};

/** 2. Pure deletion — a has lines that b does not */
const pureDeletion: DiffFixture = {
	label: "pure-deletion",
	description:
		"Lines removed from a only. Should show red line bg only, no inline highlight. Empty space on b side.",
	language: "typescript",
	original: lines(
		"function greet(name: string) {",
		"  // Old comment 1",
		"  // Old comment 2",
		"  // Old comment 3",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  return `Hello, ${name}!`;",
		"}",
	),
	modified: lines(
		"function greet(name: string) {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  return `Hello, ${name}!`;",
		"}",
	),
};

/** 3. Inline change — same line count, only content differs */
const inlineChange: DiffFixture = {
	label: "inline-change",
	description:
		"Same line count, partial content changed. Should show inline highlight on changed characters.",
	language: "typescript",
	original: lines(
		"const MAX_RETRIES = 3;",
		"const TIMEOUT_MS = 1000;",
		"const BASE_URL = 'http://localhost';",
	),
	modified: lines(
		"const MAX_RETRIES = 5;",
		"const TIMEOUT_MS = 3000;",
		"const BASE_URL = 'https://api.example.com';",
	),
};

/** 4. Mixed — some lines replaced (both sides have content), some pure additions */
const mixedReplaceAndAdd: DiffFixture = {
	label: "mixed-replace-and-add",
	description:
		"Mix of replaced lines (show inline highlight) and pure additions (no inline highlight).",
	language: "typescript",
	original: lines(
		"export function fetchUser(id: string) {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  return fetch(`/api/users/${id}`);",
		"}",
	),
	modified: lines(
		"export async function fetchUser(id: string) {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  const res = await fetch(`/api/users/${id}`);",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture string
		"  if (!res.ok) throw new Error(`HTTP ${res.status}`);",
		"  return res.json();",
		"}",
	),
};

/** 5. Block replacement — large block on a replaced by larger block on b */
const blockReplacement: DiffFixture = {
	label: "block-replacement",
	description:
		"Multiple lines on both sides changed. Inline highlight on changed parts within lines.",
	language: "typescript",
	original: lines(
		"class UserService {",
		"  private db: Database;",
		"",
		"  constructor(db: Database) {",
		"    this.db = db;",
		"  }",
		"",
		"  getUser(id: string) {",
		"    return this.db.find(id);",
		"  }",
		"}",
	),
	modified: lines(
		"class UserService {",
		"  private readonly db: DatabaseClient;",
		"  private readonly cache: CacheClient;",
		"",
		"  constructor(db: DatabaseClient, cache: CacheClient) {",
		"    this.db = db;",
		"    this.cache = cache;",
		"  }",
		"",
		"  async getUser(id: string) {",
		"    const cached = await this.cache.get(id);",
		"    if (cached) return cached;",
		"    return this.db.find(id);",
		"  }",
		"}",
	),
};

/** 6. File-level addition — original is empty */
const fileAdded: DiffFixture = {
	label: "file-added",
	description:
		"Original is empty, all lines are added. No inline highlight anywhere.",
	language: "typescript",
	original: "",
	modified: lines(
		"import { z } from 'zod';",
		"",
		"export const userSchema = z.object({",
		"  id: z.string().uuid(),",
		"  name: z.string().min(1),",
		"  email: z.string().email(),",
		"});",
		"",
		"export type User = z.infer<typeof userSchema>;",
	),
};

/** 7. File-level deletion — modified is empty */
const fileDeleted: DiffFixture = {
	label: "file-deleted",
	description:
		"Modified is empty, all lines are deleted. No inline highlight anywhere.",
	language: "typescript",
	original: lines(
		"// This file is being deleted",
		"export const LEGACY_CONFIG = {",
		"  host: 'localhost',",
		"  port: 3000,",
		"};",
	),
	modified: "",
};

/** 8. Single character change */
const singleCharChange: DiffFixture = {
	label: "single-char-change",
	description:
		"Only one character differs per line. Inline highlight should be tight.",
	language: "typescript",
	original: lines("const x = 1;", "const y = 2;", "const z = 3;"),
	modified: lines("const x = 2;", "const y = 4;", "const z = 6;"),
};

/** 9. Whitespace-only change */
const whitespaceChange: DiffFixture = {
	label: "whitespace-change",
	description: "Indentation / trailing space changes only.",
	language: "typescript",
	original: lines("function foo() {", "return 42;", "}"),
	modified: lines("function foo() {", "  return 42;", "}"),
};

/** 10. Realistic: before/after refactor */
const realisticRefactor: DiffFixture = {
	label: "realistic-refactor",
	description:
		"Realistic before/after of a small refactor with all patterns present.",
	language: "typescript",
	original: lines(
		"import React from 'react';",
		"import { useState } from 'react';",
		"",
		"export function Counter() {",
		"  const [count, setCount] = useState(0);",
		"",
		"  function increment() {",
		"    setCount(count + 1);",
		"  }",
		"",
		"  function decrement() {",
		"    setCount(count - 1);",
		"  }",
		"",
		"  return (",
		"    <div>",
		"      <button onClick={decrement}>-</button>",
		"      <span>{count}</span>",
		"      <button onClick={increment}>+</button>",
		"    </div>",
		"  );",
		"}",
	),
	modified: lines(
		"import { useState, useCallback } from 'react';",
		"",
		"interface CounterProps {",
		"  initialValue?: number;",
		"  step?: number;",
		"}",
		"",
		"export function Counter({ initialValue = 0, step = 1 }: CounterProps) {",
		"  const [count, setCount] = useState(initialValue);",
		"",
		"  const increment = useCallback(() => setCount((c) => c + step), [step]);",
		"  const decrement = useCallback(() => setCount((c) => c - step), [step]);",
		"",
		"  return (",
		'    <div className="counter">',
		"      <button onClick={decrement}>−</button>",
		"      <output>{count}</output>",
		"      <button onClick={increment}>+</button>",
		"    </div>",
		"  );",
		"}",
	),
};

export const diffFixtures: Record<string, DiffFixture> = {
	pureInsertion,
	pureDeletion,
	inlineChange,
	mixedReplaceAndAdd,
	blockReplacement,
	fileAdded,
	fileDeleted,
	singleCharChange,
	whitespaceChange,
	realisticRefactor,
};

export const diffFixtureList: DiffFixture[] = Object.values(diffFixtures);
