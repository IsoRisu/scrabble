# Contributing to Scrabble

## How to Run
1. Install Python dependencies: `pip install -r requirements.txt`
2. Run the development server: `python app.py`
3. Open `http://localhost:5000` in your browser.

## How to Run Tests
Run the test suite using pytest:
```bash
pytest
```

## Style Rules
- Use LF line endings for all files.
- Use named constants instead of magic numbers or strings.
- Do not use `innerHTML` for setting plain text; use `textContent` instead.
- Ensure all icon-only buttons include an `aria-label` attribute.

## Testing Requirement
Any changes to game behavior or bug fixes must include a corresponding test.
