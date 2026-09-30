import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CorsManager } from '../src/governance/cors-manager';
import fs from 'fs';
import path from 'path';

const testCorsFile = path.resolve('/tmp/test-cors-origins.json');

describe('Admin: Dynamic CORS Configuration Endpoint', () => {
  let corsManager: CorsManager;

  beforeEach(() => {
    vi.stubEnv('CORS_PERSIST_PATH', testCorsFile);
    if (fs.existsSync(testCorsFile)) {
      fs.unlinkSync(testCorsFile);
    }
    corsManager = new CorsManager();
  });

  afterEach(() => {
    if (fs.existsSync(testCorsFile)) {
      fs.unlinkSync(testCorsFile);
    }
    vi.unstubAllEnvs();
  });

  describe('GET /admin/cors - List allowed origins', () => {
    it('should return empty list by default', () => {
      const origins = corsManager.listOrigins();
      expect(Array.isArray(origins)).toBe(true);
      expect(origins.length).toBe(0);
    });

    it('should return all configured origins', () => {
      corsManager.addOrigin('https://example.com');
      corsManager.addOrigin('https://app.example.com');
      corsManager.addOrigin('https://admin.example.com');

      const origins = corsManager.listOrigins();
      expect(origins).toContain('https://example.com');
      expect(origins).toContain('https://app.example.com');
      expect(origins).toContain('https://admin.example.com');
      expect(origins.length).toBe(3);
    });

    it('should persist origins to disk', () => {
      corsManager.addOrigin('https://localhost:3000');
      corsManager.addOrigin('https://prod.example.com');

      const fileContent = fs.readFileSync(testCorsFile, 'utf8');
      const persisted = JSON.parse(fileContent);

      expect(persisted).toContain('https://localhost:3000');
      expect(persisted).toContain('https://prod.example.com');
    });
  });

  describe('POST /admin/cors - Add origin', () => {
    it('should add a new origin', () => {
      const result = corsManager.addOrigin('https://newapp.example.com');
      expect(result).toBe(true);

      const origins = corsManager.listOrigins();
      expect(origins).toContain('https://newapp.example.com');
    });

    it('should return false when adding duplicate origin', () => {
      corsManager.addOrigin('https://duplicate.com');
      const result = corsManager.addOrigin('https://duplicate.com');

      expect(result).toBe(false);
      const origins = corsManager.listOrigins();
      expect(origins.filter((o) => o === 'https://duplicate.com').length).toBe(1);
    });

    it('should persist added origin to disk', () => {
      corsManager.addOrigin('https://persist.example.com');

      const fileContent = fs.readFileSync(testCorsFile, 'utf8');
      const persisted = JSON.parse(fileContent);

      expect(persisted).toContain('https://persist.example.com');
    });

    it('should support wildcard origins', () => {
      corsManager.addOrigin('*.example.com');

      const origins = corsManager.listOrigins();
      expect(origins).toContain('*.example.com');
    });

    it('should reject the * wildcard because it would be sent with credentials', () => {
      const result = corsManager.addOrigin('*');

      expect(result).toBe(false);
      expect(corsManager.listOrigins()).not.toContain('*');
      expect(corsManager.isAllowed('https://anything.example')).toBe(false);
    });
  });

  describe('DELETE /admin/cors - Remove origin', () => {
    it('should remove an existing origin', () => {
      corsManager.addOrigin('https://remove.example.com');
      let origins = corsManager.listOrigins();
      expect(origins).toContain('https://remove.example.com');

      const result = corsManager.removeOrigin('https://remove.example.com');
      expect(result).toBe(true);

      origins = corsManager.listOrigins();
      expect(origins).not.toContain('https://remove.example.com');
    });

    it('should return false when removing non-existent origin', () => {
      const result = corsManager.removeOrigin('https://nonexistent.com');
      expect(result).toBe(false);
    });

    it('should persist removal to disk', () => {
      corsManager.addOrigin('https://todelete.example.com');
      corsManager.removeOrigin('https://todelete.example.com');

      const fileContent = fs.readFileSync(testCorsFile, 'utf8');
      const persisted = JSON.parse(fileContent);

      expect(persisted).not.toContain('https://todelete.example.com');
    });

    it('should remove correct origin when multiple exist', () => {
      corsManager.addOrigin('https://app1.example.com');
      corsManager.addOrigin('https://app2.example.com');
      corsManager.addOrigin('https://app3.example.com');

      corsManager.removeOrigin('https://app2.example.com');

      const origins = corsManager.listOrigins();
      expect(origins).toContain('https://app1.example.com');
      expect(origins).not.toContain('https://app2.example.com');
      expect(origins).toContain('https://app3.example.com');
    });
  });

  describe('Origin validation with dynamic configuration', () => {
    it('should allow configured origins', () => {
      corsManager.addOrigin('https://trusted.example.com');

      const allowed = corsManager.isAllowed('https://trusted.example.com');
      expect(allowed).toBe(true);
    });

    it('should reject unconfigured origins', () => {
      corsManager.addOrigin('https://trusted.example.com');

      const allowed = corsManager.isAllowed('https://untrusted.example.com');
      expect(allowed).toBe(false);
    });

    it('should allow wildcard subdomain matches', () => {
      corsManager.addOrigin('*.example.com');

      expect(corsManager.isAllowed('https://app.example.com')).toBe(true);
      expect(corsManager.isAllowed('https://admin.example.com')).toBe(true);
      expect(corsManager.isAllowed('https://example.com')).toBe(true);
      expect(corsManager.isAllowed('https://other.com')).toBe(false);
    });

    it('should fail closed when the allowlist is empty', () => {
      expect(corsManager.listOrigins()).toHaveLength(0);

      expect(corsManager.isAllowed('https://anywhere.example.com')).toBe(false);
      expect(corsManager.isAllowed('null')).toBe(false);
    });

    it('should allow every origin only with the development-only CORS_ALLOW_ANY opt-in', () => {
      vi.stubEnv('CORS_ALLOW_ANY', 'true');

      expect(corsManager.isAllowed('https://anywhere.example.com')).toBe(true);
      expect(corsManager.isAllowed('https://random.com')).toBe(true);

      const options = corsManager.getCorsOptions();
      expect(options.origin).toBe(true);
      expect(options.credentials).toBe(false);
    });

    it('should reject the * wildcard as a stored pattern while credentials are enabled', () => {
      expect(corsManager.validateOrigin('*').valid).toBe(false);
      expect(corsManager.addOrigin('*')).toBe(false);
      expect(corsManager.getCorsOptions().credentials).toBe(true);
    });

    it('should return CORS options with configured origins', () => {
      corsManager.addOrigin('https://allowed.com');

      const corsOptions = corsManager.getCorsOptions();
      expect(corsOptions).toHaveProperty('origin');
      expect(corsOptions).toHaveProperty('credentials');
      expect(corsOptions).toHaveProperty('methods');
      expect(corsOptions).toHaveProperty('allowedHeaders');
      expect(corsOptions).toHaveProperty('exposedHeaders');
      expect(corsOptions.credentials).toBe(true);
    });

    it('should include rate limit headers in exposed headers', () => {
      const corsOptions = corsManager.getCorsOptions();
      expect(corsOptions.exposedHeaders).toContain('X-RateLimit-Limit');
      expect(corsOptions.exposedHeaders).toContain('X-RateLimit-Remaining');
      expect(corsOptions.exposedHeaders).toContain('X-RateLimit-Reset');
    });
  });

  describe('Persistence and reload', () => {
    it('should persist multiple origins', () => {
      corsManager.addOrigin('https://persist1.com');
      corsManager.addOrigin('https://persist2.com');
      corsManager.addOrigin('*.dynamic.com');

      const fileContent = fs.readFileSync(testCorsFile, 'utf8');
      const persisted = JSON.parse(fileContent);

      expect(persisted.length).toBe(3);
      expect(persisted).toContain('https://persist1.com');
      expect(persisted).toContain('https://persist2.com');
      expect(persisted).toContain('*.dynamic.com');
    });

    it('should load persisted origins on init', () => {
      corsManager.addOrigin('https://saved.com');

      const newManager = new CorsManager();
      const origins = newManager.listOrigins();

      expect(origins).toContain('https://saved.com');
    });
  });

  describe('Origin pattern validation', () => {
    it('should accept absolute http(s) origins, wildcards, and the literal null', () => {
      const valid = ['https://app.example.com', 'http://localhost:3000', '*.example.com', 'null'];
      for (const pattern of valid) {
        expect(corsManager.validateOrigin(pattern).valid, pattern).toBe(true);
        expect(corsManager.addOrigin(pattern), pattern).toBe(true);
      }

      expect(corsManager.isAllowed('http://localhost:3000')).toBe(true);
      expect(corsManager.isAllowed('null')).toBe(true);
      expect(corsManager.isAllowed('https://deep.sub.example.com')).toBe(true);
    });

    it('should reject malformed, schemeless, path-bearing, and non-http origins', () => {
      const invalid = [
        'not a url',
        'example.com',
        'javascript:alert(1)',
        'https://example.com/path',
        'https://example.com?query=1',
        '*.example.com/path',
        'ftp://files.example.com',
        '',
      ];
      for (const pattern of invalid) {
        expect(corsManager.validateOrigin(pattern).valid, pattern).toBe(false);
        expect(corsManager.addOrigin(pattern), pattern).toBe(false);
      }

      expect(corsManager.listOrigins()).toHaveLength(0);
      expect(corsManager.isAllowed('https://example.com')).toBe(false);
    });
  });
});
