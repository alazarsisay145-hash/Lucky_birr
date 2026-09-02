'use strict';

/**
 * Manual payment destinations (where players send money before uploading proof).
 *
 * The list is deploy-time configuration only: it is parsed and validated once at
 * startup from `MANUAL_PAYMENT_ACCOUNTS_JSON` and is never taken from a request
 * body, so a browser can never add a destination or change an account number.
 * Only the fields a player needs in order to transfer money are ever exposed.
 */

const DESTINATION_TYPES = ['telebirr', 'bank'];

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const ACCOUNT_PATTERN = /^[0-9][0-9 +-]{5,31}$/;

// Ethiopian mobile numbers: 09xxxxxxxx / 07xxxxxxxx, or the +251 / 251 form.
const ETHIOPIAN_PHONE_PATTERN = /^(?:\+?251|0)(?:9|7)\d{8}$/;

const DEFAULT_TELEBIRR_NUMBER = '0936719379';

function normaliseText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalisePhone(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
}

/** True when `value` is a syntactically valid Ethiopian mobile number. */
function isEthiopianPhone(value) {
  return ETHIOPIAN_PHONE_PATTERN.test(normalisePhone(value));
}

/**
 * Validates a single destination entry. Returns `{ destination }` on success or
 * `{ error }` with a message that is safe to log (it never echoes the account
 * number back).
 */
function validateDestination(entry, index) {
  const where = `MANUAL_PAYMENT_ACCOUNTS_JSON[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: `${where} must be an object` };
  }

  const id = normaliseText(entry.id, 41).toLowerCase();
  if (!ID_PATTERN.test(id)) {
    return { error: `${where}.id must match ${ID_PATTERN}` };
  }

  const type = normaliseText(entry.type, 20).toLowerCase();
  if (!DESTINATION_TYPES.includes(type)) {
    return { error: `${where}.type must be one of ${DESTINATION_TYPES.join(', ')}` };
  }

  const bankName = normaliseText(entry.bank_name || entry.label, 60);
  if (bankName.length < 2) {
    return { error: `${where}.bank_name is required` };
  }

  const accountHolder = normaliseText(entry.account_holder, 80);
  if (accountHolder.length < 2) {
    return { error: `${where}.account_holder is required` };
  }

  const accountNumber = normaliseText(entry.account_number, 32);
  if (!ACCOUNT_PATTERN.test(accountNumber)) {
    return { error: `${where}.account_number is not a valid account or phone number` };
  }
  if (type === 'telebirr' && !isEthiopianPhone(accountNumber)) {
    return { error: `${where}.account_number must be an Ethiopian mobile number for a telebirr destination` };
  }

  return {
    destination: {
      id,
      type,
      bank_name: bankName,
      account_holder: accountHolder,
      account_number: accountNumber,
      instructions: normaliseText(entry.instructions, 200) || null
    }
  };
}

/** The always-available Telebirr destination requested by the operator. */
function defaultDestinations(env = process.env) {
  const number = normaliseText(env.TELEBIRR_NUMBER, 32) || DEFAULT_TELEBIRR_NUMBER;
  return [
    {
      id: 'telebirr',
      type: 'telebirr',
      bank_name: 'Telebirr',
      account_holder: normaliseText(env.TELEBIRR_ACCOUNT_HOLDER, 80) || 'Lucky Birr',
      account_number: isEthiopianPhone(number) ? number : DEFAULT_TELEBIRR_NUMBER,
      instructions: null
    }
  ];
}

/**
 * Parses and validates the configured destinations. Invalid configuration never
 * takes the deployment down and never falls back to guessed bank details: the
 * operator's Telebirr destination is used and the problem is reported through
 * `warnings` so it shows up in the boot log.
 */
function loadDestinations(env = process.env) {
  const raw = typeof env.MANUAL_PAYMENT_ACCOUNTS_JSON === 'string'
    ? env.MANUAL_PAYMENT_ACCOUNTS_JSON.trim()
    : '';
  const warnings = [];

  if (!raw) {
    return { destinations: defaultDestinations(env), warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    warnings.push('MANUAL_PAYMENT_ACCOUNTS_JSON is not valid JSON – falling back to the Telebirr destination only.');
    return { destinations: defaultDestinations(env), warnings };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    warnings.push('MANUAL_PAYMENT_ACCOUNTS_JSON must be a non-empty array – falling back to the Telebirr destination only.');
    return { destinations: defaultDestinations(env), warnings };
  }

  const destinations = [];
  const seen = new Set();
  for (let i = 0; i < parsed.length; i += 1) {
    const { destination, error } = validateDestination(parsed[i], i);
    if (error) {
      warnings.push(`${error} – entry ignored.`);
      continue;
    }
    if (seen.has(destination.id)) {
      warnings.push(`MANUAL_PAYMENT_ACCOUNTS_JSON contains a duplicate id "${destination.id}" – entry ignored.`);
      continue;
    }
    seen.add(destination.id);
    destinations.push(destination);
  }

  if (destinations.length === 0) {
    warnings.push('No usable entries in MANUAL_PAYMENT_ACCOUNTS_JSON – falling back to the Telebirr destination only.');
    return { destinations: defaultDestinations(env), warnings };
  }

  // The operator's Telebirr number must always be offered, even when the
  // configuration only lists banks.
  if (!destinations.some((d) => d.type === 'telebirr')) {
    destinations.unshift(...defaultDestinations(env));
  }

  return { destinations, warnings };
}

/** Only the fields a player needs in order to transfer the money. */
function publicView(destinations) {
  return destinations.map((d) => ({
    id: d.id,
    type: d.type,
    bank_name: d.bank_name,
    account_holder: d.account_holder,
    account_number: d.account_number,
    instructions: d.instructions
  }));
}

/** Masks all but the last 4 characters, for notifications and logs. */
function maskAccount(value) {
  const text = String(value || '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return '*'.repeat(text.length - 4) + text.slice(-4);
}

module.exports = {
  ACCOUNT_PATTERN,
  DEFAULT_TELEBIRR_NUMBER,
  DESTINATION_TYPES,
  defaultDestinations,
  isEthiopianPhone,
  loadDestinations,
  maskAccount,
  publicView,
  validateDestination
};
