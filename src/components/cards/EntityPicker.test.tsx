import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntityMultiPicker } from './EntityPicker';

vi.mock('../../api/ha-rest', () => ({
  getAllEntityStates: vi.fn(async () => [
    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
    { entity_id: 'switch.kettle', state: 'off', attributes: { friendly_name: 'Kettle' } },
    { entity_id: 'cover.garage', state: 'closed', attributes: { friendly_name: 'Garage' } },
    { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } },
  ]),
}));

describe('EntityMultiPicker', () => {
  it('offers every entity when no domains are given', async () => {
    render(<EntityMultiPicker selectedIds={[]} onToggle={() => {}} />);

    expect(await screen.findByLabelText('Garage')).toBeInTheDocument();
    expect(screen.getByLabelText('Front door')).toBeInTheDocument();
  });

  it('offers only entities of the given domains', async () => {
    render(<EntityMultiPicker selectedIds={[]} onToggle={() => {}} domains={['light', 'switch']} />);

    expect(await screen.findByLabelText('Kitchen')).toBeInTheDocument();
    expect(screen.getByLabelText('Kettle')).toBeInTheDocument();
    expect(screen.queryByLabelText('Garage')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Front door')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by domain' })).not.toHaveTextContent(/cover|lock/);
  });

  it('still lists an already-selected entity outside those domains, so it can be removed', async () => {
    render(<EntityMultiPicker selectedIds={['cover.garage']} onToggle={() => {}} domains={['light', 'switch']} />);

    expect(await screen.findByLabelText('Garage')).toBeChecked();
    expect(screen.queryByLabelText('Front door')).not.toBeInTheDocument();
  });
});
