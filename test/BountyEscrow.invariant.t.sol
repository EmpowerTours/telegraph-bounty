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

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostOpenRewards;
    uint256 public ghostPayouts; // number of bounties settled (paid or reclaimed)
    mapping(uint256 => uint256) public settleCount;
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
        vm.prank(hunters[who % 3]);
        try escrow.submit(id, h) {} catch {}
    }

    function resolve(uint256 idSeed, uint8 proofSeed, bool valid) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        bytes32 h = keccak256(abi.encode(proofSeed % 4));
        (,, bool settledBefore,, uint96 reward,,) = escrow.bounties(id);
        vm.prank(VERIFIER);
        try escrow.resolve(id, h, valid, bytes32(0)) {
            (,, bool settledAfter,,,,) = escrow.bounties(id);
            if (!settledBefore && settledAfter) {
                ghostOpenRewards -= reward;
                settleCount[id]++;
                ghostPayouts++;
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
        address a = isPoster ? posters[who % 3] : hunters[who % 3];
        uint256 amt = escrow.owed(a);
        vm.prank(a);
        try escrow.withdraw() {
            ghostWithdrawn += amt;
        } catch {}
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function sumOwed() external view returns (uint256 s) {
        for (uint256 i; i < 3; i++) {
            s += escrow.owed(posters[i]) + escrow.owed(hunters[i]);
        }
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

    /// Coverage evidence: shows the campaign actually reaches payouts/reclaims (-vv to see it).
    function afterInvariant() external view {
        console2.log("bounties posted", handler.idsLength());
        console2.log("bounties settled", handler.ghostPayouts());
        console2.log("wei withdrawn", handler.ghostWithdrawn());
    }
}
