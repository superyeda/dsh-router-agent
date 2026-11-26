// A missing preference is an existing installation, not a reason to stop at
// the chooser. Unknown stored values must never opt into automatic dispatch.
export const ROUTE_MODES = Object.freeze({auto:'自动选择（默认）',confirm:'不确定时先问我'});
export const isAutomaticRoute = settings => settings?.routingMode == null || settings.routingMode === 'auto';
export const isRouteMode = value => typeof value==='string' && Object.hasOwn(ROUTE_MODES,value);
