"""
Shared utility functions for task extraction endpoints.

Used by both extract_task.py and extract_task_enhanced.py.
"""

from datetime import datetime, timedelta
from typing import Optional
import re


def get_date_context() -> dict:
    """Get date context for LLM prompt"""
    now = datetime.now()
    return {
        "today": now.strftime("%Y-%m-%d %A"),
        "tomorrow": (now + timedelta(days=1)).strftime("%Y-%m-%d"),
    }


def parse_flexible_date(date_str: Optional[str], reference: datetime) -> Optional[str]:
    """Parse natural language dates with enhanced patterns"""
    if not date_str:
        return None

    try:
        # Try parsing ISO format first
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except ValueError:
        pass

    # Common relative date patterns
    lower = date_str.lower()
    now = reference

    # "tomorrow" with optional time
    if 'tomorrow' in lower:
        dt = now + timedelta(days=1)
        # Default to 9am for "tomorrow"
        return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "today" with optional time
    if 'today' in lower or 'tonight' in lower:
        # Default to 5pm for "today/tonight"
        return now.replace(hour=17, minute=0, second=0, microsecond=0).isoformat()

    # "next [day]" pattern
    next_day_match = re.search(r'next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)', lower)
    if next_day_match:
        day_name = next_day_match.group(1)
        days_of_week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        target_day = days_of_week.index(day_name)
        current_day = now.weekday()
        days_ahead = (target_day - current_day + 7) % 7
        if days_ahead == 0:
            days_ahead = 7  # Next week, not today
        dt = now + timedelta(days=days_ahead)
        return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "in X [days|hours|weeks]"
    in_match = re.search(r'in\s+(\d+)\s+(hour|day|week)s?', lower)
    if in_match:
        amount = int(in_match.group(1))
        unit = in_match.group(2)
        if unit == 'hour':
            dt = now + timedelta(hours=amount)
            return dt.isoformat()
        elif unit == 'day':
            dt = now + timedelta(days=amount)
            return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()
        elif unit == 'week':
            dt = now + timedelta(weeks=amount)
            return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "by [day]" pattern
    by_match = re.search(r'by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)', lower)
    if by_match:
        day_name = by_match.group(1)
        days_of_week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        target_day = days_of_week.index(day_name)
        current_day = now.weekday()
        days_ahead = (target_day - current_day + 7) % 7
        dt = now + timedelta(days=days_ahead)
        return dt.replace(hour=17, minute=0, second=0, microsecond=0).isoformat()

    # "[day] at [time]" pattern
    at_time_match = re.search(r'at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?', lower)
    if at_time_match:
        hour = int(at_time_match.group(1))
        minute = int(at_time_match.group(2)) if at_time_match.group(2) else 0
        meridiem = at_time_match.group(3)

        if meridiem == 'pm' and hour < 12:
            hour += 12
        elif meridiem == 'am' and hour == 12:
            hour = 0

        dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return dt.isoformat()

    return None


def validate_priority(priority: str) -> str:
    """Normalize priority value"""
    priority = priority.lower().strip()
    if priority in ('high', 'urgent', 'critical', 'important'):
        return 'high'
    if priority in ('low', 'eventually', 'someday'):
        return 'low'
    return 'medium'
