import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AtlasProfile from './atlas-profile.ts';
import GroupManager from '../base/group.ts';

vi.mock('../base/group.ts', () => ({
    default: { list: vi.fn(), updateAll: vi.fn() }
}));

function setup() {
    const calls: string[] = [];

    vi.mocked(GroupManager.list).mockResolvedValue([
        { name: 'ADSB', active: true }
    ] as never);
    vi.mocked(GroupManager.updateAll).mockImplementation(async (channels) => {
        calls.push('update');
        return channels;
    });

    const profile = Object.create(AtlasProfile.prototype) as AtlasProfile;
    profile.atlas = {
        db: {
            clear: vi.fn(async () => {
                calls.push('clear');
            })
        },
        postMessage: vi.fn()
    } as never;
    vi.spyOn(profile, 'postChannelStatus').mockResolvedValue();

    return { profile, calls };
}

describe('AtlasProfile channels', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('tells TAK before clearing, then clears late arrivals', async () => {
        const { profile, calls } = setup();

        await profile.setChannel('ADSB', false);
        expect(calls).toEqual(['update', 'clear']);

        await vi.advanceTimersByTimeAsync(2000);
        expect(calls).toEqual(['update', 'clear', 'clear']);
    });

    it('does not clear the map when turning a channel on', async () => {
        const { profile, calls } = setup();

        await profile.setChannel('ADSB', true);
        await vi.advanceTimersByTimeAsync(2000);

        expect(calls).toEqual(['update']);
    });

    it('turning back on cancels the pending clear', async () => {
        const { profile, calls } = setup();

        await profile.setChannel('ADSB', false);
        await profile.setChannel('ADSB', true);
        await vi.advanceTimersByTimeAsync(2000);

        expect(calls).toEqual(['update', 'clear', 'update']);
    });

    it('applies the same order when switching all channels off', async () => {
        const { profile, calls } = setup();

        await profile.setAllChannels(false);

        expect(calls).toEqual(['update', 'clear']);
    });
});
