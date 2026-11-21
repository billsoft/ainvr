/** Explicit operator-configured aliases are the only evidence that two resources share a guard. */
export class PhysicalPtzGuards {
  readonly groups: readonly (readonly string[])[];
  private readonly keys = new Map<string, string>();

  constructor(groups: unknown = JSON.parse(process.env.AINVR_PTZ_MOTOR_GROUPS || '[]')) {
    if (!Array.isArray(groups) || groups.length > 256) throw Error('Invalid PTZ motor groups');
    this.groups = groups.map((group: unknown) => {
      if (!Array.isArray(group) || group.length < 2 || group.length > 16)
        throw Error('Invalid PTZ motor group');
      const members: string[] = [];
      for (const key of group) {
        if (typeof key !== 'string' || !/^(onvif|gb28181):[^\s]{1,256}$/.test(key) ||
            this.keys.has(key) || members.includes(key))
          throw Error('Invalid or duplicate PTZ motor resource');
        members.push(key);
      }
      const canonical = members.find(key => key.startsWith('onvif:')) ?? members[0];
      for (const key of members) this.keys.set(key, canonical);
      return members;
    });
  }

  key(resource: string) { return this.keys.get(resource) ?? resource; }
  grouped(resource: string) { return this.keys.has(resource); }
}
