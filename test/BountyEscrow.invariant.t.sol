// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";

/// Drives the escrow with random posters, hunters, verifier verdicts, time warps, reclaims
/// and withdrawals, while keeping ghost accounting of where every wei should be.
contract EscrowHandler is Test {
    BountyEscrow public immutable escrow;
    address[3] public posters = [address(0x501), address(0x502), address(0x503)];
    address[3] public hunters = [address(0x601), address(0x602), address(0x603)];
    address public constant VERIFIER = address(0x7001);
    address public constant ATTACKER = address(0xBAD);

    struct Key {
        uint256 id;
        bytes32 proofHash;
        address hunter;
    }

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostOpenRewards;
    uint256 public ghostPayouts; // number of bounties settled (paid or reclaimed)
    mapping(uint256 => uint256) public settleCount;
    mapping(uint256 => mapping(bytes32 => mapping(address => bool))) public honestlyCommitted;
    mapping(uint256 => mapping(bytes32 => mapping(address => uint256))) public resolveCount;
    Key[] public resolvedKeys;
    Key[] public committedKeys;
    uint256 public ghostPaidVerdicts;
    uint256 public ghostResolvedUncommitted; // resolves accepted for a key its hunter never committed
    uint256 public ghostWrongPayee; // a settlement that credited anyone but the claimed hunter
    uint256[] public ids;

    constructor(BountyEscrow e) {
        escrow = e;
    }

    function post(uint256 who, uint96 reward, uint32 duration) external {
        reward = uint96(bound(reward, 1, 50 ether));
        duration = uint32(bound(duration, 1, 30 days));
        address p = posters[who % 3];
        vm.deal(p, reward);
        vm.prank(p);
        uint256 id = escrow.post{value: reward}(VERIFIER, uint64(block.timestamp + duration), keccak256("t"), keccak256("i"));
        ids.push(id);
        ghostDeposited += reward;
        ghostOpenRewards += reward;
    }

    function submit(uint256 idSeed, uint256 who, uint8 proofSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        bytes32 h = keccak256(abi.encode(proofSeed % 4));
        address hu = hunters[who % 3];
        bytes32 c = escrow.commitmentOf(id, h, hu); // before the prank: a view call would consume it
        vm.prank(hu);
        try escrow.submit(id, c) {
            honestlyCommitted[id][h][hu] = true;
            committedKeys.push(Key(id, h, hu));
        } catch {}
    }

    /// The attacker copies any honest hunter's commitment (as seen in the mempool or on-chain),
    /// on the same bounty or on another one, and also commits its own bogus commitments.
    function attackerCopy(uint256 idSeed, uint256 otherIdSeed, uint256 who, uint8 proofSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        uint256 onId = ids[otherIdSeed % ids.length];
        bytes32 h = keccak256(abi.encode(proofSeed % 4));
        bytes32 c = escrow.commitmentOf(id, h, hunters[who % 3]);
        vm.prank(ATTACKER);
        try escrow.submit(onId, c) {} catch {}
    }

    /// Resolves a random honest commitment (so the campaign reaches real verdicts), sometimes
    /// claiming it for the attacker instead, and sometimes a random (possibly uncommitted) key.
    function resolve(uint256 seed, uint256 idSeed, uint256 who, uint8 proofSeed, uint8 mode, bool valid) external {
        if (ids.length == 0) return;
        uint256 id;
        bytes32 h;
        address claimed;
        if (committedKeys.length > 0 && mode % 3 != 2) {
            Key memory k = committedKeys[seed % committedKeys.length];
            (id, h, claimed) = (k.id, k.proofHash, mode % 3 == 1 ? ATTACKER : k.hunter);
        } else {
            id = ids[idSeed % ids.length];
            h = keccak256(abi.encode(proofSeed % 4));
            claimed = who % 4 == 3 ? ATTACKER : hunters[who % 3];
        }
        (,, bool settledBefore,, uint96 reward,,) = escrow.bounties(id);
        uint256 owedBefore = escrow.owed(claimed);
        vm.prank(VERIFIER);
        try escrow.resolve(id, h, claimed, valid, bytes32(0)) {
            resolveCount[id][h][claimed]++;
            if (resolveCount[id][h][claimed] == 1) resolvedKeys.push(Key(id, h, claimed));
            if (!honestlyCommitted[id][h][claimed]) ghostResolvedUncommitted++;
            (,, bool settledAfter,,,,) = escrow.bounties(id);
            if (!settledBefore && settledAfter) {
                ghostOpenRewards -= reward;
                settleCount[id]++;
                ghostPayouts++;
                ghostPaidVerdicts++;
                if (escrow.owed(claimed) != owedBefore + reward) ghostWrongPayee++;
            }
        } catch {}
    }

    function reclaim(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address p,,,, uint96 reward,,) = escrow.bounties(id);
        vm.prank(p);
        try escrow.reclaim(id) {
            ghostOpenRewards -= reward;
            settleCount[id]++;
            ghostPayouts++;
        } catch {}
    }

    function withdraw(uint256 who, bool isPoster) external {
        address a = isPoster ? posters[who % 3] : (who % 4 == 3 ? ATTACKER : hunters[who % 3]);
        uint256 amt = escrow.owed(a);
        vm.prank(a);
        try escrow.withdraw() {
            ghostWithdrawn += amt;
        } catch {}
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }

    function committedKeysLength() external view returns (uint256) {
        return committedKeys.length;
    }

    function resolvedKeysLength() external view returns (uint256) {
        return resolvedKeys.length;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function sumOwed() external view returns (uint256 s) {
        for (uint256 i; i < 3; i++) {
            s += escrow.owed(posters[i]) + escrow.owed(hunters[i]);
        }
        s += escrow.owed(ATTACKER) + escrow.owed(VERIFIER);
    }
}

contract BountyEscrowInvariantTest is Test {
    BountyEscrow internal escrow;
    EscrowHandler internal handler;

    function setUp() public {
        escrow = new BountyEscrow();
        handler = new EscrowHandler(escrow);
        targetContract(address(handler));
    }

    /// Every wei ever posted is either withdrawn or still held by the escrow.
    function invariant_conservation() public view {
        assertEq(handler.ghostDeposited(), handler.ghostWithdrawn() + address(escrow).balance);
    }

    /// The escrow holds exactly the open rewards plus the credited-but-unwithdrawn balances.
    function invariant_solvency() public view {
        assertEq(address(escrow).balance, handler.ghostOpenRewards() + handler.sumOwed());
    }

    /// No bounty is ever settled more than once (paid twice, or paid and reclaimed).
    function invariant_settledAtMostOnce() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            assertLe(handler.settleCount(handler.ids(i)), 1);
        }
    }

    /// Only the committing hunter can be paid: the attacker, who only ever copies other hunters'
    /// commitments, is never credited anything, and no resolve was ever accepted for a
    /// (bounty, proof, hunter) key that hunter did not commit itself.
    function invariant_onlyCommittingHunterPaid() public view {
        assertEq(escrow.owed(handler.ATTACKER()), 0);
        assertEq(handler.ghostResolvedUncommitted(), 0);
        assertEq(handler.ghostWrongPayee(), 0);
    }

    /// Each commitment is resolved at most once (one stored verdict, never re-rejected/flipped).
    function invariant_commitmentResolvedAtMostOnce() public view {
        uint256 n = handler.resolvedKeysLength();
        for (uint256 i; i < n; i++) {
            (uint256 id, bytes32 h, address hu) = handler.resolvedKeys(i);
            assertEq(handler.resolveCount(id, h, hu), 1);
            assertTrue(escrow.verdictOf(id, h, hu) != BountyEscrow.Verdict.None);
        }
    }

    /// Coverage evidence: shows the campaign actually reaches payouts/reclaims (-vv to see it).
    function afterInvariant() external view {
        console2.log("bounties posted", handler.idsLength());
        console2.log("bounties settled", handler.ghostPayouts());
        console2.log("wei withdrawn", handler.ghostWithdrawn());
        console2.log("honest commitments", handler.committedKeysLength());
        console2.log("paid verdicts", handler.ghostPaidVerdicts());
        console2.log("commitments resolved", handler.resolvedKeysLength());
    }
}
