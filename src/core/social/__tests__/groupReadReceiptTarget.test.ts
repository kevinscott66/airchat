import { isGroupReadReceiptTarget } from '../groupReadReceiptTarget';
import { makeGroupSysText } from '../groupSysLine';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('group read receipt targets', () => {
  it('skips control events with empty or real sender keys', () => {
    expect(isGroupReadReceiptTarget({ senderPubB64: '', text: makeGroupSysText('joined') }, 'me')).toBe(false);
    expect(isGroupReadReceiptTarget({ senderPubB64: 'peer', text: makeGroupSysText('created') }, 'me')).toBe(false);
    expect(isGroupReadReceiptTarget({ senderPubB64: '', text: 'legacy row' }, 'me')).toBe(false);
  });
  it('keeps actual incoming messages eligible and own messages excluded', () => {
    expect(isGroupReadReceiptTarget({ senderPubB64: 'peer', text: 'hello' }, 'me')).toBe(true);
    expect(isGroupReadReceiptTarget({ senderPubB64: 'me', text: 'hello' }, 'me')).toBe(false);
  });
  it('screen filters before claiming the sender deduplication slot', () => {
    const src = readFileSync(join(__dirname, '../../../ui/screens/GroupsScreen.tsx'), 'utf8');
    const begin = src.indexOf('for (const msg of msgs.slice(0, 20))');
    const filter = src.indexOf('!isGroupReadReceiptTarget(msg, myPubB64)', begin);
    const claim = src.indexOf('sentReceipts.add(msg.senderPubB64)', begin);
    expect(filter).toBeGreaterThan(begin);
    expect(claim).toBeGreaterThan(filter);
  });
});
