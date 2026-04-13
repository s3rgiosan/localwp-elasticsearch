import { promises as fs } from 'fs';
import * as path from 'path';
import type { Site } from '@getflywheel/local';

const MARKER_BEGIN = '// BEGIN Local Elasticsearch';
const MARKER_END = '// END Local Elasticsearch';
const BLOCK_RE = new RegExp(
	`\\n?${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`,
	'g'
);

function wpConfigPath(site: Site): string | null {
	const webRoot = (site as any).paths?.webRoot;
	if (!webRoot) return null;
	return path.join(webRoot, 'wp-config.php');
}

function buildBlock(host: string): string {
	return `${MARKER_BEGIN}\ndefine( 'EP_HOST', '${host}' );\n${MARKER_END}`;
}

function stripBlock(contents: string): string {
	return contents.replace(BLOCK_RE, '\n');
}

function insertBlock(contents: string, block: string): string {
	const stripped = stripBlock(contents);
	const marker = /\/\*\s*That's all, stop editing!/i;
	if (marker.test(stripped)) {
		return stripped.replace(marker, `${block}\n\n$&`);
	}
	const phpOpen = stripped.indexOf('<?php');
	if (phpOpen !== -1) {
		const after = phpOpen + '<?php'.length;
		return `${stripped.slice(0, after)}\n${block}\n${stripped.slice(after)}`;
	}
	return `${block}\n${stripped}`;
}

function defineLineRegex(name: string): RegExp {
	return new RegExp(`define\\s*\\(\\s*(['"])${name}\\1\\s*,\\s*[^)]*\\)\\s*;?`, 'i');
}

export async function setEpHostConstant(site: Site, hostUri: string): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		const contents = await fs.readFile(file, 'utf8');

		// If our block exists, ensure it's current.
		if (contents.includes(MARKER_BEGIN)) {
			const next = contents.replace(BLOCK_RE, `\n${buildBlock(hostUri)}\n`);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		// If EP_HOST is defined outside our block, update its value in place.
		const defRe = defineLineRegex('EP_HOST');
		if (defRe.test(contents)) {
			const next = contents.replace(defRe, `define( 'EP_HOST', '${hostUri}' );`);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		// Otherwise insert our marked block.
		const next = insertBlock(contents, buildBlock(hostUri));
		if (next === contents) return true;
		await fs.writeFile(file, next, 'utf8');
		return true;
	} catch (err) {
		console.warn(`[elasticsearch] Failed to write EP_HOST for ${site.name}:`, err);
		return false;
	}
}

export async function getEpHostConstant(site: Site): Promise<string | null> {
	const file = wpConfigPath(site);
	if (!file) return null;
	try {
		const contents = await fs.readFile(file, 'utf8');
		const match = contents.match(/define\s*\(\s*['"]EP_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

export async function removeEpHostConstant(site: Site): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		const contents = await fs.readFile(file, 'utf8');
		if (!contents.includes(MARKER_BEGIN)) return true;
		const next = stripBlock(contents);
		if (next === contents) return true;
		await fs.writeFile(file, next, 'utf8');
		return true;
	} catch (err) {
		console.warn(`[elasticsearch] Failed to remove EP_HOST for ${site.name}:`, err);
		return false;
	}
}
