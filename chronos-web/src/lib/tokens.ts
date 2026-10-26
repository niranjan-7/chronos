import { Tenant } from '../types/tenant';

export const CHRONOS_DEFAULT_JWT_SECRET =
  process.env.NEXT_PUBLIC_JWT_SECRET ||
  'chronos-super-secret-jwt-key-32-chars-min!';

export const DEFAULT_TENANTS: Tenant[] = [
  {
    id: 'a03a3200-b6ed-4314-b1d5-a24099a62f9a',
    name: 'Acme Corp',
    slug: 'acme-corp',
    personas: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Alex Rivera (Admin)',
        email: 'alex.rivera@acme.corp',
        role: 'ADMIN',
        avatar: 'AR',
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Sarah Chen (Tier-3 WebRTC)',
        email: 'sarah.chen@acme.corp',
        role: 'AGENT',
        avatar: 'SC',
        skills: ['voice_webrtc', 'messaging_a2p'],
        maxCapacity: 5,
      },
      {
        id: '00000000-0000-0000-0000-000000000003',
        name: 'David Kim (Billing & API)',
        email: 'david.kim@acme.corp',
        role: 'AGENT',
        avatar: 'DK',
        skills: ['rest_api', 'billing'],
        maxCapacity: 4,
      },
    ],
  },
  {
    id: 'b12b4300-c7fe-5425-c2e6-b35100b73g0b',
    name: 'Stark Industries',
    slug: 'stark-industries',
    personas: [
      {
        id: '00000000-0000-0000-0000-000000000010',
        name: 'Tony Stark (Admin)',
        email: 'tony@stark.corp',
        role: 'ADMIN',
        avatar: 'TS',
      },
      {
        id: '00000000-0000-0000-0000-000000000011',
        name: 'Peter Parker (Support Specialist)',
        email: 'peter@stark.corp',
        role: 'AGENT',
        avatar: 'PP',
        skills: ['voice_webrtc', 'rest_api'],
        maxCapacity: 5,
      },
    ],
  },
  {
    id: 'c23c5400-d8gf-6536-d3f7-c46211c84h1c',
    name: 'Globex Corp',
    slug: 'globex-corp',
    personas: [
      {
        id: '00000000-0000-0000-0000-000000000020',
        name: 'Hank Scorpio (Executive)',
        email: 'hank@globex.corp',
        role: 'ADMIN',
        avatar: 'HS',
      },
      {
        id: '00000000-0000-0000-0000-000000000021',
        name: 'Homer Simpson (Field Agent)',
        email: 'homer@globex.corp',
        role: 'AGENT',
        avatar: 'HM',
        skills: ['messaging_a2p'],
        maxCapacity: 3,
      },
    ],
  },
];

function base64UrlEncode(str: string): string {
  const base64 = typeof btoa === 'function' ? btoa(str) : Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return base64UrlEncode(binary);
}

/**
 * Generates a browser-signed HS256 JWT token using native Web Crypto API.
 */
export async function createClientJwt(
  tenantId: string,
  userId: string,
  role: string,
  secret: string = CHRONOS_DEFAULT_JWT_SECRET,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    userId,
    tenantId,
    tenant_id: tenantId,
    role,
    roles: [role],
    iat: now,
    exp: now + 86400 * 7, // 7 days
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const encodedSignature = bufferToBase64Url(signature);
    return `${data}.${encodedSignature}`;
  }

  // Fallback signature for non-crypto environments
  return `${data}.mock_dev_signature_${base64UrlEncode(secret).slice(0, 16)}`;
}
