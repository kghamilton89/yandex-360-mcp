1. One Yandex OAuth app per server/mode; tokens carry every scope ever granted to that app.
2. Never claim a scope subset limits a token without checking the granted scope and testing access.
