def validate_payload(data):
    """Dummy validator for future expansion."""
    if data is None:
        return {}
    if not isinstance(data, dict):
        return {}
    return data