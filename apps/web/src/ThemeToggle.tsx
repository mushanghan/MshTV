import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme';

export function ThemeToggle() {
  const light = useTheme(state => state.theme === 'light');
  const toggle = useTheme(state => state.toggle);
  const action = light ? '切换到深色主题' : '切换到浅色主题';
  return <button type="button" className="icon-button theme-toggle" aria-label={action} title={action} onClick={toggle}>
    {light ? <Moon size={17}/> : <Sun size={17}/>}
  </button>;
}
