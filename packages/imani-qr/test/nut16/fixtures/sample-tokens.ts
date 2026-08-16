import { createFrameProducer, stringToBytes } from '../../../src/nut16/ur-codec';

export const SHORT_CASHU_B =
  'cashuBo2F0gaJhaUgArvSFnZG9JmFwgaNhYRhAYXNYIDJfafCO_BkX0jXKHbsHkr8K2YCAaWNGl3FmsLEjsZ-V';

export const MEDIUM_CASHU_B =
  'cashuBo2F0gaJhaUgArvSFnZG9JmFwg6NhYRgQYXNYIDJfafCO_BkX0jXKHbsHkr8K2YCAaWNGl3FmsLEjsZ-V' +
  'YWNYIQODNHCBhSWP3HmwjOh7sV6vk_NXjmkJEYXuLk_jPkJzWGFkomFlWCBkYNblvqlrqVZbWxRkUkpHEQyHA0WT' +
  'Hm-eVQs6Jb8WdmFp-A';

export const LONG_CASHU_B =
  'cashuB' +
  'o2F0gaJhaUgArvSFnZG9JmFwh6NhYQJhc1ggMl9p8I_8GRfSNcoduweSvwrZgIBpY0aXcWawsSOxn5VhY1ghAoM0' +
  'cIGFJY_cebCM6HuxXq-T81eOaQkRhe4uT-M-QnNYYWQAo2FhBGFzWCAyX2nwj_wZF9I1yh27B5K_CtmAgGljRpdx' +
  'ZrCxI7GflWFjWCECgzRwgYUlj9x5sIzoe7Fer5PzV45pCRGF7i5P4z5Cc1iC';

export function buildFragments(token: string, maxFragmentLength = 100): string[] {
  const producer = createFrameProducer(stringToBytes(token), maxFragmentLength);
  const out: string[] = [];
  // Pull 2× the natural fragment count to handle fountain-code redundancy.
  const target = Math.max(producer.fragmentsLength * 2, 5);
  for (let i = 0; i < target; i += 1) {
    out.push(producer.nextPart());
  }
  return out;
}
