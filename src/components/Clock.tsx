import { format } from 'date-fns';
import { useClock } from '../hooks/useClock';

export function Clock() {
  const now = useClock();

  return (
    <span className="clock-mini">
      {format(now, 'h:mm a')}
    </span>
  );
}
