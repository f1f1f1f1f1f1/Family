import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

const desktop = () => within(document.querySelector<HTMLElement>('.sidebar--desktop')!);

describe('Sidebar', () => {
  it('offers AirPlay only when the add-on has a receiver', () => {
    const { rerender } = render(<Sidebar activeView="dashboard" onChangeView={() => {}} />);
    expect(desktop().queryByRole('button', { name: 'AirPlay' })).toBeNull();

    rerender(<Sidebar activeView="dashboard" onChangeView={() => {}} showAirPlay />);
    const labels = desktop().getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(labels.indexOf('AirPlay')).toBe(labels.indexOf('Photos') + 1);
  });

  it('opens the AirPlay screen, marked while shown', () => {
    const onChangeView = vi.fn();
    render(<Sidebar activeView="airplay" onChangeView={onChangeView} showAirPlay />);
    const button = desktop().getByRole('button', { name: 'AirPlay' });
    expect(button.classList.contains('sidebar-icon--active')).toBe(true);
    fireEvent.click(button);
    expect(onChangeView).toHaveBeenCalledWith('airplay');
  });

  it("puts AirPlay in the phone layout's More menu", () => {
    const onChangeView = vi.fn();
    render(<Sidebar activeView="dashboard" onChangeView={onChangeView} showAirPlay />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(document.querySelector<HTMLElement>('.mobile-more-menu')!).getByText('AirPlay'));
    expect(onChangeView).toHaveBeenCalledWith('airplay');
  });
});
