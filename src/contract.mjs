/**
 * The provider-neutral status contract shared by every bridge
 * (`shaper-bridge/v1`). A bridge declares what it can do; a caller branches on
 * the declared capabilities, never on the engine behind them.
 *
 * Kept byte-compatible with `pkg-bridge-contract` in SHAPER OS so that a caller
 * validating one bridge validates them all.
 */
export const SHAPER_BRIDGE_PROTOCOL = 'shaper-bridge/v1';

export const DEFAULT_CAPABILITIES = Object.freeze({
  inject: true,
  events: true,
  status: true,
  stopRun: false,
  resetSession: false,
  bindWorkspace: false,
  attachments: false,
  modelSelection: false,
});

export function normalizeCapabilities(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
    out[key] = source[key] == null ? DEFAULT_CAPABILITIES[key] : Boolean(source[key]);
  }
  return out;
}

export function bridgeStatus({ service = '', ready = false, capabilities = {}, ...rest } = {}) {
  return {
    ok: true,
    protocol: SHAPER_BRIDGE_PROTOCOL,
    service: String(service || '').trim(),
    ready: Boolean(ready),
    capabilities: normalizeCapabilities(capabilities),
    ...rest,
  };
}

/** Returns readable contract faults without making a provider-specific guess. */
export function validateBridgeStatus(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['status must be an object'];
  if (raw.protocol !== SHAPER_BRIDGE_PROTOCOL) errors.push(`protocol must be ${SHAPER_BRIDGE_PROTOCOL}`);
  if (typeof raw.service !== 'string' || !raw.service.trim()) errors.push('service must be a non-empty string');
  if (typeof raw.ready !== 'boolean') errors.push('ready must be boolean');
  if (!raw.capabilities || typeof raw.capabilities !== 'object') {
    errors.push('capabilities must be an object');
  } else {
    for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
      if (typeof raw.capabilities[key] !== 'boolean') errors.push(`capabilities.${key} must be boolean`);
    }
  }
  return errors;
}
