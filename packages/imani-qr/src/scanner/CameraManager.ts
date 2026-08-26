import QrScannerLib from 'qr-scanner';

export interface CameraInfo {
  id: string;
  label: string;
}

type PermissionQuery = { name: PermissionName | 'camera' };

export class CameraManager {
  async hasPermission(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
      return false;
    }

    try {
      const result = await navigator.permissions.query({ name: 'camera' } as PermissionQuery);
      return result.state === 'granted';
    } catch {
      return false;
    }
  }

  async requestPermission(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch {
      return false;
    }
  }

  async listCameras(): Promise<CameraInfo[]> {
    try {
      // Use qr-scanner's camera listing which handles permissions properly
      const cameras = await QrScannerLib.listCameras(true);
      return cameras.map(camera => ({
        id: camera.id || '',
        label: camera.label || ''
      }));
    } catch {
      // Fallback to mediaDevices
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
        return [];
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
          .filter(device => device.kind === 'videoinput')
          .map(device => ({
            id: device.deviceId || device.groupId || '',
            label: device.label || ''
          }));
      } catch {
        return [];
      }
    }
  }

  async getPreferredCamera(preferred: 'environment' | 'user'): Promise<CameraInfo | null> {
    const cameras = await this.listCameras();
    if (!cameras.length) {
      return null;
    }

    const matcher =
      preferred === 'environment'
        ? /(back|rear|environment)/i
        : /(front|user|face|cam)/i;

    const matched = cameras.find(camera => matcher.test(camera.label));
    return matched ?? cameras[0];
  }

  /**
   * Check if any camera is available
   */
  async hasCamera(): Promise<boolean> {
    return QrScannerLib.hasCamera();
  }
}
