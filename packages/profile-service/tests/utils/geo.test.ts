import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  isWithinRadius,
  boundingBox,
  isInBoundingBox,
} from '../../src/utils/geo.js';

describe('haversineDistance', () => {
  it('should return 0 for same point', () => {
    const distance = haversineDistance(45.5, -122.6, 45.5, -122.6);
    expect(distance).toBe(0);
  });

  it('should calculate distance between Portland and Seattle', () => {
    // Portland: 45.5152, -122.6784
    // Seattle: 47.6062, -122.3321
    const distance = haversineDistance(45.5152, -122.6784, 47.6062, -122.3321);
    // Should be approximately 233 km
    expect(distance).toBeGreaterThan(230);
    expect(distance).toBeLessThan(240);
  });

  it('should calculate distance between New York and London', () => {
    // NYC: 40.7128, -74.0060
    // London: 51.5074, -0.1278
    const distance = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);
    // Should be approximately 5570 km
    expect(distance).toBeGreaterThan(5550);
    expect(distance).toBeLessThan(5600);
  });

  it('should handle antipodal points', () => {
    // Maximum distance on Earth is ~20,000 km (half circumference)
    const distance = haversineDistance(0, 0, 0, 180);
    expect(distance).toBeGreaterThan(19000);
    expect(distance).toBeLessThan(21000);
  });

  it('should handle crossing the prime meridian', () => {
    const distance = haversineDistance(51.5, -0.1, 51.5, 0.1);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(20); // Less than 20 km
  });

  it('should handle crossing the date line', () => {
    const distance = haversineDistance(0, 179.9, 0, -179.9);
    // This crosses the date line, about 22 km
    expect(distance).toBeGreaterThan(20);
    expect(distance).toBeLessThan(25);
  });
});

describe('isWithinRadius', () => {
  it('should return true for same point', () => {
    expect(isWithinRadius(45.5, -122.6, 45.5, -122.6, 1)).toBe(true);
  });

  it('should return true for point within radius', () => {
    // Two points about 1 km apart
    expect(isWithinRadius(45.5, -122.6, 45.509, -122.6, 2)).toBe(true);
  });

  it('should return false for point outside radius', () => {
    // Portland to Seattle (~233 km)
    expect(isWithinRadius(45.5152, -122.6784, 47.6062, -122.3321, 100)).toBe(false);
  });

  it('should return true for point exactly on radius boundary', () => {
    // Create a point exactly at the radius distance
    const distance = haversineDistance(45.5, -122.6, 45.509, -122.6);
    expect(isWithinRadius(45.5, -122.6, 45.509, -122.6, distance)).toBe(true);
  });
});

describe('boundingBox', () => {
  it('should create valid bounding box', () => {
    const box = boundingBox(45.5, -122.6, 10);

    expect(box.minLat).toBeLessThan(45.5);
    expect(box.maxLat).toBeGreaterThan(45.5);
    expect(box.minLon).toBeLessThan(-122.6);
    expect(box.maxLon).toBeGreaterThan(-122.6);
  });

  it('should contain center point', () => {
    const box = boundingBox(45.5, -122.6, 10);
    expect(isInBoundingBox(45.5, -122.6, box)).toBe(true);
  });

  it('should create larger box for larger radius', () => {
    const smallBox = boundingBox(45.5, -122.6, 1);
    const largeBox = boundingBox(45.5, -122.6, 100);

    expect(largeBox.maxLat - largeBox.minLat).toBeGreaterThan(
      smallBox.maxLat - smallBox.minLat
    );
  });

  it('should approximate latitude correctly', () => {
    // 1 degree latitude ≈ 111 km
    // So 10 km ≈ 0.09 degrees
    const box = boundingBox(45.5, -122.6, 10);
    const latDelta = (box.maxLat - box.minLat) / 2;

    expect(latDelta).toBeGreaterThan(0.08);
    expect(latDelta).toBeLessThan(0.1);
  });
});

describe('isInBoundingBox', () => {
  const box = { minLat: 45, maxLat: 46, minLon: -123, maxLon: -122 };

  it('should return true for point inside box', () => {
    expect(isInBoundingBox(45.5, -122.5, box)).toBe(true);
  });

  it('should return true for point on boundary', () => {
    expect(isInBoundingBox(45, -122, box)).toBe(true);
    expect(isInBoundingBox(46, -123, box)).toBe(true);
  });

  it('should return false for point outside box', () => {
    expect(isInBoundingBox(44, -122.5, box)).toBe(false); // south
    expect(isInBoundingBox(47, -122.5, box)).toBe(false); // north
    expect(isInBoundingBox(45.5, -124, box)).toBe(false); // west
    expect(isInBoundingBox(45.5, -121, box)).toBe(false); // east
  });
});
