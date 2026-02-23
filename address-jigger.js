/**
 * AddressJigger — Generates valid address variants from a single physical address.
 *
 * Purpose: When multiple bots checkout to the same physical address, stores flag
 * duplicate orders. Jigging creates cosmetically different but deliverably identical
 * addresses so each order looks unique to the store's fraud system.
 *
 * Techniques (all produce valid, deliverable addresses):
 *   1. Street number padding: "12" → "012", "12.", "#12"
 *   2. Street type abbreviation: "Street" ↔ "St" ↔ "St." ↔ "Str"
 *   3. Direction abbreviation: "North" ↔ "N" ↔ "N."
 *   4. Unit/Flat prefix: "Flat 4B" ↔ "Flat4B" ↔ "FL 4B" ↔ "Unit 4B"
 *   5. Address line 2 shuffling: move unit to line 1 or line 2
 *   6. Trailing punctuation: add/remove periods, commas
 *   7. Case variation: "MAIN STREET" ↔ "Main Street" ↔ "main street"
 *   8. Name jigging: "John" ↔ "J." ↔ first initial, middle initial
 *   9. Postcode spacing: "SW1A 1AA" ↔ "SW1A1AA" ↔ "sw1a 1aa"
 *  10. Phone format: "+44 7911 123456" ↔ "07911123456" ↔ "07911 123 456"
 *
 * Each technique is independent → total combinations = product of all technique counts.
 */

// Street type mappings (UK + US)
const STREET_TYPES = {
  'street': ['street', 'st', 'st.', 'str'],
  'st': ['street', 'st', 'st.', 'str'],
  'st.': ['street', 'st', 'st.', 'str'],
  'road': ['road', 'rd', 'rd.'],
  'rd': ['road', 'rd', 'rd.'],
  'rd.': ['road', 'rd', 'rd.'],
  'avenue': ['avenue', 'ave', 'ave.', 'av'],
  'ave': ['avenue', 'ave', 'ave.', 'av'],
  'ave.': ['avenue', 'ave', 'ave.', 'av'],
  'drive': ['drive', 'dr', 'dr.'],
  'dr': ['drive', 'dr', 'dr.'],
  'lane': ['lane', 'ln', 'ln.'],
  'ln': ['lane', 'ln', 'ln.'],
  'close': ['close', 'cl', 'cl.'],
  'cl': ['close', 'cl', 'cl.'],
  'court': ['court', 'ct', 'ct.'],
  'ct': ['court', 'ct', 'ct.'],
  'place': ['place', 'pl', 'pl.'],
  'pl': ['place', 'pl', 'pl.'],
  'terrace': ['terrace', 'terr', 'ter'],
  'crescent': ['crescent', 'cres', 'cr'],
  'gardens': ['gardens', 'gdns', 'gdn'],
  'grove': ['grove', 'gr', 'grv'],
  'way': ['way', 'wy'],
  'park': ['park', 'pk'],
  'hill': ['hill', 'hl'],
  'square': ['square', 'sq', 'sq.'],
  'boulevard': ['boulevard', 'blvd', 'blvd.'],
};

// Unit/Flat prefix mappings (UK-focused)
const UNIT_PREFIXES = {
  'flat': ['flat', 'fl', 'flt', 'unit', 'apt'],
  'fl': ['flat', 'fl', 'flt', 'unit', 'apt'],
  'flt': ['flat', 'fl', 'flt', 'unit', 'apt'],
  'unit': ['unit', 'flat', 'fl', 'apt'],
  'apt': ['apt', 'apt.', 'apartment', 'flat', 'unit'],
  'apartment': ['apartment', 'apt', 'apt.', 'flat', 'unit'],
};

// Direction mappings
const DIRECTIONS = {
  'north': ['north', 'n', 'n.'],
  'n': ['north', 'n', 'n.'],
  'south': ['south', 's', 's.'],
  's': ['south', 's', 's.'],
  'east': ['east', 'e', 'e.'],
  'e': ['east', 'e', 'e.'],
  'west': ['west', 'w', 'w.'],
  'w': ['west', 'w', 'w.'],
};

class AddressJigger {
  /**
   * Generate a jigged address variant for a specific bot index.
   * Deterministic: same index always produces the same variant.
   *
   * @param {Object} address - { firstName, lastName, address, address2, city, county, zip, country, phone, email }
   * @param {number} index - Bot index (0-49)
   * @returns {Object} Jigged address with same keys
   */
  static jig(address, index) {
    if (index === 0) return { ...address }; // First bot uses original address

    const jigged = { ...address };

    // Seed deterministic choices from index
    const seed = index;

    // 1. Street address jigging
    jigged.address = this._jigStreetAddress(address.address || '', seed);

    // 2. Address line 2 jigging
    jigged.address2 = this._jigAddressLine2(address.address2 || '', address.address || '', seed);

    // 3. Name jigging (subtle)
    jigged.firstName = this._jigFirstName(address.firstName || '', seed);
    jigged.lastName = this._jigLastName(address.lastName || '', seed);

    // 4. Postcode jigging (spacing/case)
    jigged.zip = this._jigPostcode(address.zip || '', seed);

    // 5. City jigging (case)
    jigged.city = this._jigCity(address.city || '', seed);

    // 6. Phone jigging (format)
    jigged.phone = this._jigPhone(address.phone || '', seed);

    return jigged;
  }

  static _jigStreetAddress(addr, seed) {
    if (!addr) return addr;
    let result = addr;

    // Extract street number
    const numMatch = result.match(/^(\d+)\s+(.+)/);
    if (numMatch) {
      const num = numMatch[1];
      const rest = numMatch[2];
      const numVariants = [num, `${num}.`, `0${num}`, `#${num}`];
      result = `${numVariants[seed % numVariants.length]} ${rest}`;
    }

    // Replace street type with variant
    const words = result.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const lower = words[i].toLowerCase().replace(/[.,]$/, '');
      if (STREET_TYPES[lower]) {
        const variants = STREET_TYPES[lower];
        const pick = variants[(seed + i) % variants.length];
        // Match original case
        if (words[i][0] === words[i][0].toUpperCase()) {
          words[i] = pick.charAt(0).toUpperCase() + pick.slice(1);
        } else {
          words[i] = pick;
        }
      }
      // Direction jigging
      const dirLower = words[i].toLowerCase().replace(/[.]$/, '');
      if (DIRECTIONS[dirLower]) {
        const variants = DIRECTIONS[dirLower];
        const pick = variants[(seed + i + 1) % variants.length];
        if (words[i][0] === words[i][0].toUpperCase()) {
          words[i] = pick.charAt(0).toUpperCase() + pick.slice(1);
        } else {
          words[i] = pick;
        }
      }
    }
    result = words.join(' ');

    // Case variation (every 5th bot)
    if (seed % 5 === 1) result = result.toUpperCase();
    else if (seed % 5 === 2) result = result.toLowerCase();

    // Trailing punctuation
    if (seed % 3 === 1 && !result.endsWith('.')) result += '.';
    else if (seed % 3 === 2) result = result.replace(/[.,]+$/, '');

    return result;
  }

  static _jigAddressLine2(addr2, addr1, seed) {
    if (!addr2) {
      // Generate a line 2 from nothing using common patterns
      const fillers = ['', '.', ',', '-'];
      return fillers[seed % fillers.length];
    }

    let result = addr2;

    // Jig unit/flat prefixes
    const words = result.split(/\s+/);
    if (words.length >= 1) {
      const lower = words[0].toLowerCase().replace(/[.,]$/, '');
      if (UNIT_PREFIXES[lower]) {
        const variants = UNIT_PREFIXES[lower];
        const pick = variants[seed % variants.length];
        words[0] = pick.charAt(0).toUpperCase() + pick.slice(1);
      }
    }
    result = words.join(' ');

    // Spacing variation: "Flat 4B" vs "Flat4B"
    if (seed % 4 === 1) result = result.replace(/(\D)\s+(\d)/, '$1$2');
    if (seed % 4 === 2) result = result.replace(/(\D)(\d)/, '$1 $2');

    // Case
    if (seed % 6 === 3) result = result.toUpperCase();
    else if (seed % 6 === 4) result = result.toLowerCase();

    return result;
  }

  static _jigFirstName(name, seed) {
    if (!name) return name;
    const variants = [
      name,                                          // John
      name.charAt(0).toUpperCase() + '.',            // J.
      name.charAt(0).toUpperCase(),                  // J
      name.toUpperCase(),                            // JOHN
      name.toLowerCase(),                            // john
      name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(), // John (normalized)
    ];
    return variants[seed % variants.length];
  }

  static _jigLastName(name, seed) {
    if (!name) return name;
    const variants = [
      name,                                          // Smith
      name.toUpperCase(),                            // SMITH
      name.toLowerCase(),                            // smith
      name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(), // Smith (normalized)
    ];
    return variants[seed % variants.length];
  }

  static _jigPostcode(zip, seed) {
    if (!zip) return zip;
    const clean = zip.replace(/\s+/g, '').toUpperCase();
    // UK postcodes: insert space before last 3 chars
    const variants = [
      zip, // original
      clean, // no space: SW1A1AA
      clean.length > 3 ? clean.slice(0, -3) + ' ' + clean.slice(-3) : clean, // spaced: SW1A 1AA
      zip.toLowerCase(), // lowercase: sw1a 1aa
      clean.toLowerCase(), // lowercase no space: sw1a1aa
    ];
    return variants[seed % variants.length];
  }

  static _jigCity(city, seed) {
    if (!city) return city;
    const variants = [
      city,
      city.toUpperCase(),
      city.toLowerCase(),
      city.charAt(0).toUpperCase() + city.slice(1).toLowerCase(),
    ];
    return variants[seed % variants.length];
  }

  static _jigPhone(phone, seed) {
    if (!phone) return phone;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) return phone;

    // UK phone variants
    const variants = [
      phone, // original
      digits, // pure digits: 07911123456
      digits.replace(/^44/, '0'), // local format
      `+44 ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`, // +44 791 112 3456
      `0${digits.slice(-10, -6)} ${digits.slice(-6)}`, // 07911 123456
      `(0${digits.slice(-10, -7)}) ${digits.slice(-7)}`, // (0791) 1123456
    ];
    return variants[seed % variants.length];
  }

  /**
   * Calculate total number of unique valid permutations for a given address.
   */
  static countPermutations(address) {
    let streetNumVariants = 1;
    let streetTypeVariants = 1;
    let directionVariants = 1;
    let caseVariants = 3; // normal, upper, lower
    let punctuationVariants = 3; // none, period, clean
    let line2Variants = 1;
    let firstNameVariants = 1;
    let lastNameVariants = 1;
    let postcodeVariants = 1;
    let cityVariants = 4; // original, upper, lower, title
    let phoneVariants = 1;

    // Street number
    if (address.address && /^\d+\s/.test(address.address)) {
      streetNumVariants = 4; // num, num., 0num, #num
    }

    // Street type
    const addrWords = (address.address || '').split(/\s+/);
    for (const w of addrWords) {
      const lower = w.toLowerCase().replace(/[.,]$/, '');
      if (STREET_TYPES[lower]) {
        streetTypeVariants = STREET_TYPES[lower].length;
        break;
      }
    }

    // Directions
    for (const w of addrWords) {
      const lower = w.toLowerCase().replace(/[.]$/, '');
      if (DIRECTIONS[lower]) {
        directionVariants = DIRECTIONS[lower].length;
        break;
      }
    }

    // Line 2
    if (address.address2) {
      const l2Words = (address.address2 || '').split(/\s+/);
      const l2Lower = (l2Words[0] || '').toLowerCase().replace(/[.,]$/, '');
      if (UNIT_PREFIXES[l2Lower]) {
        line2Variants = UNIT_PREFIXES[l2Lower].length * 2 * 3; // prefix * spacing * case
      } else {
        line2Variants = 3; // case variants
      }
    } else {
      line2Variants = 4; // empty fillers
    }

    // Names
    if (address.firstName) firstNameVariants = 6;
    if (address.lastName) lastNameVariants = 4;

    // Postcode
    if (address.zip) postcodeVariants = 5;

    // Phone
    const digits = (address.phone || '').replace(/\D/g, '');
    if (digits.length >= 10) phoneVariants = 6;

    const total = streetNumVariants * streetTypeVariants * directionVariants *
      caseVariants * punctuationVariants * line2Variants *
      firstNameVariants * lastNameVariants * postcodeVariants *
      cityVariants * phoneVariants;

    return {
      total,
      breakdown: {
        streetNumber: streetNumVariants,
        streetType: streetTypeVariants,
        direction: directionVariants,
        addressCase: caseVariants,
        punctuation: punctuationVariants,
        addressLine2: line2Variants,
        firstName: firstNameVariants,
        lastName: lastNameVariants,
        postcode: postcodeVariants,
        city: cityVariants,
        phone: phoneVariants,
      },
    };
  }
}

module.exports = { AddressJigger };
