import { promises as fs } from 'fs';
import * as path from 'path';
import type { Site } from '@getflywheel/local';
import type { Result } from './types';

const MARKER_BEGIN = '// BEGIN Local Elasticsearch';
const MARKER_END = '// END Local Elasticsearch';

/** Prefix added to a site's own literal EP_HOST define while the add-on block is active. */
const DISABLED_PREFIX = '// Disabled by Local Elasticsearch: ';

const STOP_EDITING_RE = /\/\*\s*That's all, stop editing!/i;

/** Any reference to an EP_HOST define, used to detect defines the add-on cannot parse. */
const EP_HOST_DEFINE_RE = /\bdefine\s*\(\s*(['"])EP_HOST\1/i;
const EP_HOST_DEFINE_ALL_RE = new RegExp(EP_HOST_DEFINE_RE.source, 'gi');

/**
 * A line holding exactly one `define( 'EP_HOST', '<literal>' );` statement,
 * optionally guarded by `defined( 'EP_HOST' ) ||` and followed by a line comment.
 * Group 2 holds a single-quoted value, group 3 a double-quoted one.
 */
const LITERAL_DEFINE_LINE_RE =
	/^\s*(?:defined\s*\(\s*['"]EP_HOST['"]\s*\)\s*(?:\|\||or)\s*)?define\s*\(\s*(['"])EP_HOST\1\s*,\s*(?:'([^'\\]*)'|"([^"\\$]*)")\s*\)\s*;\s*(?:(?:\/\/|#).*)?$/i;

type Scan = {
	/** Line ranges [begin, end] of add-on marker blocks. */
	blocks: [number, number][];
	/** EP_HOST value inside the first marker block. */
	blockValue: string | null;
	/** Indexes of active literal EP_HOST defines outside the marker blocks. */
	foreignLines: number[];
	/** Value of the first active literal EP_HOST define outside the marker blocks. */
	foreignValue: string | null;
	/** An active EP_HOST define outside the marker blocks is not a single-line literal. */
	foreignNonLiteral: boolean;
	/** A marker block has no closing marker. */
	unterminatedBlock: boolean;
};

function wpConfigPath(site: Site): string | null {
	const webRoot = site.paths?.webRoot;
	if (!webRoot) return null;
	return path.join(webRoot, 'wp-config.php');
}

function withoutCr(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function literalValue(line: string): string | null {
	const match = withoutCr(line).match(LITERAL_DEFINE_LINE_RE);
	if (!match) return null;
	return match[2] ?? match[3] ?? '';
}

/**
 * Returns the part of a line that is PHP code, given whether the line starts
 * inside a block comment. Comments are dropped; quoted strings are kept as-is
 * so comment markers inside them (e.g. in salts or URLs) are ignored.
 */
function codeOf(line: string, inComment: boolean): { code: string; inComment: boolean } {
	let code = '';
	let comment = inComment;
	let quote: string | null = null;
	let i = 0;
	while (i < line.length) {
		const char = line[i];
		const pair = line.slice(i, i + 2);
		if (comment) {
			if (pair === '*/') {
				comment = false;
				i += 2;
			} else {
				i++;
			}
			continue;
		}
		if (quote) {
			if (char === '\\') {
				code += pair;
				i += 2;
				continue;
			}
			if (char === quote) quote = null;
			code += char;
			i++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			code += char;
			i++;
			continue;
		}
		if (pair === '/*') {
			comment = true;
			i += 2;
			continue;
		}
		if (pair === '//' || char === '#') break;
		code += char;
		i++;
	}
	return { code, inComment: comment };
}

function scan(lines: string[]): Scan {
	const result: Scan = {
		blocks: [],
		blockValue: null,
		foreignLines: [],
		foreignValue: null,
		foreignNonLiteral: false,
		unterminatedBlock: false,
	};
	let blockStart = -1;
	let inComment = false;
	/** Comment-free code outside the marker blocks, one entry per line. */
	const code: string[] = [];

	lines.forEach((rawLine, index) => {
		const line = withoutCr(rawLine);
		const trimmed = line.trim();
		if (blockStart !== -1) {
			if (trimmed === MARKER_END) {
				result.blocks.push([blockStart, index]);
				blockStart = -1;
				return;
			}
			if (result.blockValue === null) result.blockValue = literalValue(line);
			return;
		}
		if (!inComment && trimmed === MARKER_BEGIN) {
			blockStart = index;
			return;
		}

		const parsed = codeOf(line, inComment);
		inComment = parsed.inComment;
		code.push(parsed.code);
		if (!EP_HOST_DEFINE_RE.test(parsed.code)) return;

		const value = literalValue(line);
		if (value === null) {
			result.foreignNonLiteral = true;
			return;
		}
		result.foreignLines.push(index);
		if (result.foreignValue === null) result.foreignValue = value;
	});

	if (blockStart !== -1) result.unterminatedBlock = true;

	// Each recognized literal line holds one define; any extra match, such as a
	// define split across lines, is one the add-on cannot rewrite.
	const defineCount = code.join('\n').match(EP_HOST_DEFINE_ALL_RE)?.length ?? 0;
	if (defineCount > result.foreignLines.length) result.foreignNonLiteral = true;
	return result;
}

function eolOf(contents: string): string {
	return contents.includes('\r\n') ? '\r\n' : '\n';
}

/** Removes every marker block, plus the blank line that follows each one. */
function withoutBlocks(lines: string[], blocks: [number, number][]): string[] {
	const drop = new Set<number>();
	for (const [begin, end] of blocks) {
		for (let i = begin; i <= end; i++) drop.add(i);
		const next = lines[end + 1] ?? null;
		const nextTrimmed = next === null ? null : next.trim();
		if (nextTrimmed === '') drop.add(end + 1);
	}
	return lines.filter((_, index) => !drop.has(index));
}

function restoreDisabled(lines: string[]): string[] {
	return lines.map((line) => (line.startsWith(DISABLED_PREFIX) ? line.slice(DISABLED_PREFIX.length) : line));
}

/** Reads wp-config.php. Returns null when it does not exist and throws on any other error. */
async function readConfig(site: Site): Promise<{ file: string; contents: string } | null> {
	const file = wpConfigPath(site);
	if (!file) return null;
	try {
		const contents = await fs.readFile(file, 'utf8');
		return { file, contents };
	} catch (err) {
		const { code } = err as NodeJS.ErrnoException;
		if (code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * Replaces the file through a temp file in the same directory, so a crash
 * leaves either the old or the new contents. Symlinks are followed and the
 * original file mode is kept. The temp file ends in `.php`, so the web server
 * never serves a leftover one as plain text.
 */
async function writeAtomic(file: string, contents: string): Promise<void> {
	const target = await fs.realpath(file);
	const { mode } = await fs.stat(target);
	const base = path.basename(target, '.php');
	const temp = path.join(path.dirname(target), `.${base}.${process.pid}.${Date.now()}.tmp.php`);
	try {
		await fs.writeFile(temp, contents, { encoding: 'utf8', mode });
		await fs.chmod(temp, mode);
		await fs.rename(temp, target);
	} catch (err) {
		await fs.unlink(temp).catch(() => undefined);
		throw err;
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * EP_HOST written by the add-on, read from its marker block only. Throws when
 * wp-config.php exists but cannot be read.
 */
export async function getEpHost(site: Site): Promise<string | null> {
	const config = await readConfig(site);
	if (!config) return null;
	return scan(config.contents.split('\n')).blockValue;
}

/**
 * Active literal EP_HOST defined by the site itself, outside the marker block.
 * Throws when wp-config.php exists but cannot be read.
 */
export async function getForeignEpHost(site: Site): Promise<string | null> {
	const config = await readConfig(site);
	if (!config) return null;
	return scan(config.contents.split('\n')).foreignValue;
}

/**
 * Writes the marker block with `hostUri`. A literal EP_HOST defined elsewhere
 * in the file is commented out with a recognizable prefix so removal can
 * restore it.
 */
export async function setEpHost(site: Site, hostUri: string): Promise<Result> {
	const file = wpConfigPath(site);
	if (!file) return { ok: false, error: 'The site has no web root.' };

	let contents: string;
	try {
		contents = await fs.readFile(file, 'utf8');
	} catch (err) {
		return { ok: false, error: `Could not read wp-config.php: ${describe(err)}` };
	}

	const eol = eolOf(contents);
	const lines = contents.split('\n');
	const found = scan(lines);
	if (found.unterminatedBlock) {
		return { ok: false, error: 'The Local Elasticsearch block in wp-config.php has no end marker.' };
	}
	if (found.foreignNonLiteral) {
		return {
			ok: false,
			error: 'EP_HOST is already defined in wp-config.php with a value the add-on cannot rewrite.',
		};
	}

	const cr = eol === '\r\n' ? '\r' : '';
	const block = [MARKER_BEGIN, `define( 'EP_HOST', '${hostUri}' );`, MARKER_END, ''].map((l) => l + cr);

	const disabled = new Set(found.foreignLines);
	const commented = lines.map((line, index) => (disabled.has(index) ? DISABLED_PREFIX + line : line));

	let insertAt: number;
	if (found.blocks.length > 0) {
		insertAt = found.blocks[0][0];
	} else {
		insertAt = commented.findIndex((line) => STOP_EDITING_RE.test(line));
		if (insertAt === -1) {
			const phpOpen = commented.findIndex((line) => line.includes('<?php'));
			if (phpOpen === -1) return { ok: false, error: 'wp-config.php has no opening PHP tag.' };
			insertAt = phpOpen + 1;
		}
	}

	const before = withoutBlocks(commented.slice(0, insertAt), found.blocks.filter(([, end]) => end < insertAt));
	const after = withoutBlocks(
		commented.slice(insertAt),
		found.blocks
			.filter(([begin]) => begin >= insertAt)
			.map(([begin, end]): [number, number] => [begin - insertAt, end - insertAt])
	);
	const next = [...before, ...block, ...after].join('\n');
	if (next === contents) return { ok: true };

	try {
		await writeAtomic(file, next);
		return { ok: true };
	} catch (err) {
		console.warn(`[elasticsearch] Failed to write EP_HOST for ${site.name}:`, err);
		return { ok: false, error: `Could not write wp-config.php: ${describe(err)}` };
	}
}

/**
 * Removes the marker block and restores any EP_HOST define the add-on
 * commented out.
 */
export async function removeEpHost(site: Site): Promise<Result> {
	const file = wpConfigPath(site);
	if (!file) return { ok: false, error: 'The site has no web root.' };

	let contents: string;
	try {
		contents = await fs.readFile(file, 'utf8');
	} catch (err) {
		return { ok: false, error: `Could not read wp-config.php: ${describe(err)}` };
	}

	const lines = contents.split('\n');
	const found = scan(lines);
	if (found.unterminatedBlock) {
		return { ok: false, error: 'The Local Elasticsearch block in wp-config.php has no end marker.' };
	}

	const next = restoreDisabled(withoutBlocks(lines, found.blocks)).join('\n');
	if (next === contents) return { ok: true };

	try {
		await writeAtomic(file, next);
		return { ok: true };
	} catch (err) {
		console.warn(`[elasticsearch] Failed to remove EP_HOST for ${site.name}:`, err);
		return { ok: false, error: `Could not write wp-config.php: ${describe(err)}` };
	}
}
