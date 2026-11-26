// Renderer-side suggestion policy. The caller supplies the current, already
// authorized DSH model catalog. Names are hints, never entitlements, speed
// measurements or a replacement for exact provider/model/effort validation.
const tiers = ['fast', 'standard', 'deep'];
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const route = value => text(value?.provider) && text(value?.model);
const effortOf = value => typeof value?.effort === 'string' ? value.effort : '';
const unavailable = provider => ({provider, model:'', effort:''});

/** Absent mode on an older set of distinct tier selections means manual. */
export function modelMode(settings) {
  if (settings?.modelMode === 'auto' || settings?.modelMode === 'manual') return settings.modelMode;
  if (settings?.modelMode != null) return 'manual';
  const chosen = tiers.map(tier => settings?.tiers?.[tier]).filter(route);
  return new Set(chosen.map(value => JSON.stringify([value.provider, value.model, effortOf(value)]))).size > 1
    ? 'manual' : 'auto';
}

function validCatalog(value) {
  const byProvider = new Map();
  for (const row of Array.isArray(value) ? value : []) {
    if (!route(row) || !Array.isArray(row.efforts)) continue;
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, new Map());
    const rows = byProvider.get(row.provider);
    if (rows.has(row.model)) { rows.set(row.model, null); continue; }
    const efforts = [...new Set(row.efforts.filter(text))];
    rows.set(row.model, {...row, efforts});
  }
  return byProvider;
}

const tokens = value => (typeof value === 'string' ? value.toLowerCase().normalize('NFKC') : '').match(/[a-z0-9]+/g) ?? [];
const role = (band, specificity, family, generation, normal) => ({band, specificity, family, generation, normal});

function namedRole(value) {
  const s = typeof value === 'string' ? value.toLowerCase().normalize('NFKC').trim() : '';
  let m;
  // Built-in DSH catalog: DeepSeek-V4.1-Flash and DeepSeek-V4-Pro. Both are
  // catalogued on a number of routes; the names do not authorize any route.
  if (/\bdeepseek[ -]+(?:v4(?:\.1)?[ -]+)?flash\b/u.test(s)) return role('fast', 3, 'deepseek-v4', '4', true);
  if (/\bdeepseek[ -]+v4[ -]+pro\b/u.test(s)) return role('deep', 3, 'deepseek-v4', '4');
  if (/\bdeepseek[ -]+reasoner\b/u.test(s)) return role('deep', 2, 'deepseek-legacy', 'legacy');
  if (/\bdeepseek[ -]+chat\b/u.test(s)) return role('standard', 2, 'deepseek-legacy', 'legacy');

  // Bundled pi-ai catalog (OpenAI/Codex, Anthropic and Google). There is no
  // sorting by numeric version. Generations only establish same-family pairs.
  m = s.match(/\bgpt[ -]+(5\.6|6(?:\.\d+)?)[ -]+(luna|terra|sol|astra)\b/u);
  if (m) {
    // The bundled 5.6 and 6 names have different variant roles. Extend only
    // the recognized 6.x labels to offered variants in point releases.
    const series = m[1] === '5.6' ? {luna:'fast',terra:'standard',sol:'deep'} : {luna:'fast',sol:'standard',astra:'deep'};
    if (series[m[2]]) return role(series[m[2]], 3, 'gpt', m[1]);
  }
  m = s.match(/\bgpt[ -]+(\d+(?:\.\d+)?o?)(?:[ -]+(mini|nano|pro|codex[ -]+spark))?(?=$|[^a-z0-9.])/u);
  if (m) {
    if (m[2] === 'mini' || m[2]?.endsWith('spark')) return role('fast', 3, 'gpt', m[1]);
    if (m[2] === 'nano') return role('fast', 2, 'gpt', m[1]);
    if (m[2] === 'pro') return role('deep', 3, 'gpt', m[1]);
    if (!/\b(?:api|image|audio|realtime|tts|transcribe|search)\b/u.test(s)) return role('standard', 3, 'gpt', m[1]);
  }
  m = s.match(/\b(o[1-4])(?:[ -]+(mini|pro))?(?=$|[^a-z0-9])/u);
  if (m) return role(m[2] === 'mini' ? 'fast' : m[2] === 'pro' ? 'deep' : 'standard', 3, 'openai-o', m[1]);
  m = s.match(/\bclaude[ -]+(haiku|sonnet|opus)(?:[ -]+(\d+(?:[.-]\d+)?))?/u);
  if (m) return role(({haiku:'fast', sonnet:'standard', opus:'deep'})[m[1]], 3, 'claude', m[2]?.replace('-', '.'));
  m = s.match(/\bgemini[ -]+(?:(\d+(?:\.\d+)?)[ -]+)?(flash(?:[ -]+lite)?|pro)\b/u);
  if (m) {
    if (m[2] === 'pro') return role('deep', 3, 'gemini', m[1]);
    if (m[2] === 'flash') return role('fast', 2, 'gemini', m[1], true);
    return role('fast', 3, 'gemini', m[1]);
  }

  // Optional descriptive names as seen in the authorized renderer catalog.
  // Exact lexical tokens only (e.g. "deepseek" and "professional" are NOT tiers).
  const words = new Set(tokens(s));
  const byBand = {
    fast: ['fast','flash','mini','nano','haiku','lite','lightweight'],
    standard: ['standard','balanced','sonnet'],
    deep: ['deep','pro','opus'],
  };
  const matches = tiers.filter(tier => byBand[tier].some(word => words.has(word)));
  if (matches.length !== 1) return undefined;
  const band = matches[0];
  return role(band, words.has(band) ? 4 : 2, undefined, undefined, words.has('flash') && !words.has('lite'));
}

const notGeneral = /(?:^|[-_ /])(?:transcribe|tts|embedding|rerank|classifier|moderation|image|audio|live|realtime|computer[- ]use|customtools)(?:$|[-_ /])/iu;
const preview = /(?:^|[-_ ])(?:preview|experimental|latest|beta)(?:$|[-_ ])/iu;
const snapshot = /(?:^|[-_ ])20\d{2}(?:-?\d{2}){2}(?:$|[-_ ])/iu;
function classify(row) {
  const description = namedRole(row.model) ?? namedRole(row.name);
  return {row, description, specialty:notGeneral.test(row.model), preview:preview.test(row.model), snapshot:snapshot.test(row.model)};
}

// Stable FNV-1a ordering picks between *already equally supported choices*.
// It does not interpret alphabetical order, dates, or versions as capability.
function tieKey(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

function tiedChoice(values, keyFor) {
  let best, hash, key;
  for (const value of values) {
    const nextKey = keyFor(value), nextHash = tieKey(nextKey);
    if (best === undefined || nextHash < hash || (nextHash === hash && nextKey < key)) {
      best = value; hash = nextHash; key = nextKey;
    }
  }
  return best;
}

function catalogFamily(entries) {
  const groups = new Map();
  for (const {description, specialty} of entries) {
    if (specialty || !description?.family || !description.generation) continue;
    const key = description.family + ':' + description.generation;
    if (!groups.has(key)) groups.set(key, {key, ...description, bands:new Set()});
    groups.get(key).bands.add(description.band);
  }
  // A full, same-generation trio is positive coherence evidence. When there
  // are several full families no generation is assumed to be superior.
  return tiedChoice([...groups.values()].filter(group => group.bands.size === tiers.length), group => group.key);
}

function keepPreferred(entries, test) {
  const preferred = entries.filter(test);
  return preferred.length ? preferred : entries;
}

function pick(entries, anchor, anchorRole, tier) {
  const suitable = entries.filter(entry => !entry.specialty && entry.description?.band === tier);
  // A Flash model can remain the balanced workhorse when the provider's
  // published family only offers lightweight and flagship variants.
  const backup = tier === 'standard' && !suitable.length
    ? entries.filter(entry => !entry.specialty && entry.description?.normal === true)
    : [];
  let candidates = suitable.length ? suitable : backup;
  if (!candidates.length) return undefined;
  if (anchorRole?.family) {
    candidates = keepPreferred(candidates, entry => entry.description.family === anchorRole.family);
    if (anchorRole.generation) candidates = keepPreferred(candidates,
      entry => entry.description.family === anchorRole.family && entry.description.generation === anchorRole.generation);
  }
  const pinned = candidates.find(entry => entry.row === anchor);
  if (pinned) return pinned.row;
  candidates = keepPreferred(candidates, entry => !entry.preview);
  candidates = keepPreferred(candidates, entry => !entry.snapshot);
  const level = candidates.reduce((max, entry) => Math.max(max, entry.description.specificity), 0);
  candidates = candidates.filter(entry => entry.description.specificity === level);
  return tiedChoice(candidates, entry => entry.row.provider + '\u0000' + entry.row.model)?.row;
}

// These are DSH's and pi-ai's explicit effort IDs, not ordinal positions in
// the catalog array. Keep the exact offered spelling in the returned choice.
const effortRank = new Map([['off',0],['none',0],['minimal',1],['low',2],['medium',3],['high',4],['xhigh',5],['max',6]]);
function effortOptions(row) {
  const ours = new Map();
  for (const id of row.efforts) {
    const name = id.toLowerCase();
    if (!effortRank.has(name)) continue;
    if (ours.has(name)) { ours.set(name, null); continue; }
    ours.set(name, id);
  }
  return ours;
}

function selectEffort(row, tier, anchor, sameStandard) {
  const options = effortOptions(row);
  const preferred = (...orders) => orders.map(level => options.get(level)).find(Boolean) ?? '';
  const explicit = row.model === anchor?.model && row.efforts.includes(effortOf(anchor)) ? effortOf(anchor) : '';
  const catalogDefault = row.efforts.includes(row.defaultEffort) ? row.defaultEffort : '';
  if (new Set([...options].filter(([, id]) => id).map(([name]) => effortRank.get(name))).size < 2) return explicit;
  const standard = preferred('medium') || catalogDefault
    || (namedRole(row.model)?.family === 'deepseek-v4' ? preferred('high') : '') || explicit;
  if (tier === 'standard') return standard;
  if (tier === 'fast') return preferred('low','minimal','off','none') || standard;
  // Prefer the first supported modest high setting, not the highest by default.
  const higher = ['high','xhigh','max'].map(name => options.get(name)).filter(Boolean);
  const standardRank = sameStandard ? effortRank.get(standard.toLowerCase()) : undefined;
  return higher.find(id => effortRank.get(id.toLowerCase()) > (standardRank ?? -1)) || standard;
}

/** Resolve each tier independently inside its authorized provider. An empty
 * model means unavailable; callers must not send it to the host. This function
 * never mutates stored settings, other sessions, or the DSH default model. */
export function resolveTiers(settings, catalog) {
  const available = validCatalog(catalog);
  const mode = modelMode(settings);
  const selectedProvider = text(settings?.autoProvider) ? settings.autoProvider : '';
  const choices = tiers.map(tier => {
    const configured = settings?.tiers?.[tier];
    const inherited = text(configured?.provider) ? configured.provider : '';
    // An explicit owner selection in auto mode authorizes the new provider
    // without overwriting any manual anchors. Without it, never infer one.
    const provider = mode === 'auto' && selectedProvider ? selectedProvider : inherited;
    const models = available.get(provider);
    if (!models) return {tier, provider};
    const configuredHere = inherited === provider ? configured : undefined;
    const anchor = models.get(configuredHere?.model);
    if (mode === 'manual') {
      const effort = effortOf(configuredHere);
      const valid = configuredHere?.effort == null || typeof configuredHere.effort === 'string';
      return {tier, provider, row:valid && anchor && (!effort || anchor.efforts.includes(effort)) ? anchor : undefined, effort};
    }
    const entries = [...models.values()].filter(Boolean).map(classify);
    const anchorRole = (anchor ? classify(anchor).description : undefined) ?? namedRole(configuredHere?.model) ?? catalogFamily(entries);
    const general = entries.filter(entry => !entry.specialty);
    // If that band is not offered, reuse a proven workhorse or lightweight
    // route rather than promoting a cheap task to a premium configured model.
    const row = pick(entries, anchor, anchorRole, tier) || pick(entries, anchor, anchorRole, 'standard')
      || pick(entries, anchor, anchorRole, 'fast') || anchor || (general.length === 1 ? general[0].row : undefined);
    return {tier, provider, row, configuredHere};
  });
  const balance = choices[1].row;
  return Object.fromEntries(choices.map(({tier,provider,row,configuredHere,effort}) => [tier,
    row ? {provider, model:row.model, effort:effort ?? selectEffort(row,tier,configuredHere,row === balance)} : unavailable(provider),
  ]));
}
