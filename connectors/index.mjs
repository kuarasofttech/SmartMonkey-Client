/**
 * The connector registry. A connector is a real, tested, read-only integration;
 * anything not here is shown honestly as "coming later" — never faked.
 */
import { linear } from './linear.mjs';

export const CONNECTORS = [linear];
export const COMING_LATER = ['Jira', 'Confluence', 'Notion', 'Figma', 'GitHub Issues', 'Azure DevOps', 'ClickUp', 'Asana'];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const findConnector = name => { const n = norm(name); return n ? CONNECTORS.find(c => c.id === n || c.aliases.some(a => n.includes(a))) || null : null; };
export const allTools = () => CONNECTORS.flatMap(c => c.tools.map(t => ({ ...t, connector: c.id })));
export const findTool = name => allTools().find(t => t.name === name) || null;
