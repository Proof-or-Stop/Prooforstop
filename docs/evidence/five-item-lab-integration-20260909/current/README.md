# Current integration evidence

These files were produced for candidate 3b55ae70ddda3f6085ec0b0473847da2cacfef9c
based on main 04e66fdbaeaeeb540a80c9f8e16085a5ee468f5a. They are separate from the
historical archive. The 22 candidate controls all passed; the production-mechanism
suite also passed independently and is now included in the expanded 23-check
native gate. Its original first failure remains the required invalid-pin assertion.

The RED native command exited unsuccessfully because the real baseline CLI accepted
an explicitly required invalid implementation pin. The outer Lab command recorded
that expected failure successfully. The earlier unsuccessful bootstrap-identity
probe used an unsupported baseline flag and was not accepted as target RED.

The native record here is a read-only snapshot after RED, not a replacement for the
live HMAC-bound record in Git's common directory. Never edit or import this snapshot
as a Story credential. GREEN and finish append their own current native records.
Private fixture paths in raw logs are provenance; they are not paths to real Stories.
