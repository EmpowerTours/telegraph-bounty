// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InitVault as InitVaultVuln} from "../init-vault/InitVault.sol";
import {InitVault as InitVaultFixed} from "../init-vault/InitVaultPatched.sol";
import {ShareVault as ShareVaultVuln} from "../share-vault/ShareVault.sol";
import {ShareVault as ShareVaultFixed} from "../share-vault/ShareVaultPatched.sol";
import {TokenVault as TokenVaultVuln, LegacyToken as LegacyTokenV} from "../token-vault/TokenVault.sol";
import {TokenVault as TokenVaultFixed, LegacyToken as LegacyTokenF} from "../token-vault/TokenVaultPatched.sol";
import {Exploit as InitExploit} from "../_reference/InitVaultExploit.sol";
import {Exploit as ShareExploit} from "../_reference/ShareVaultExploit.sol";
import {Exploit as TokenExploit} from "../_reference/TokenVaultExploit.sol";

interface IShare {
    function deposit() external payable returns (uint256);
    function redeem(uint256 shares) external returns (uint256);
    function sharesOf(address) external view returns (uint256);
}

interface ITokenVaultLike {
    function token() external view returns (address);
    function deposit(uint256 amount) external;
    function totalDeposits() external view returns (uint256);
}

interface ILegacy {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract DonorT {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// Mirrors the scenarios in targets/<id>/target.js in-process. The verifier itself runs them on
/// fresh anvil chains (no cheatcodes reachable from a proof).
contract TargetsTest is Test {
    address constant DEPLOYER = address(0xD0);
    address constant ATTACKER = address(0xA77);
    address[3] users = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256[3] seeds = [uint256(3 ether), 3 ether, 4 ether];

    // ---------- init-vault ----------
    function _initVault(address v) internal {
        vm.prank(DEPLOYER);
        InitVaultVuln(payable(v)).initialize(DEPLOYER, 5 ether);
        for (uint256 i; i < 3; i++) {
            vm.deal(users[i], seeds[i]);
            vm.prank(users[i]);
            InitVaultVuln(payable(v)).deposit{value: seeds[i]}();
        }
    }

    function _initHolds(address v) internal view returns (bool) {
        return v.balance >= InitVaultVuln(payable(v)).totalDeposits();
    }

    function test_initVault_referenceBreaksVulnerable() public {
        InitVaultVuln v = new InitVaultVuln();
        _initVault(address(v));
        vm.deal(ATTACKER, 1 ether);
        vm.startPrank(ATTACKER);
        InitExploit e = new InitExploit{value: 1 ether}(address(v));
        e.run();
        vm.stopPrank();
        assertFalse(_initHolds(address(v)));
        assertEq(address(v).balance, 0);
        assertEq(v.owner(), address(e));
    }

    function test_initVault_referenceFailsOnPatched() public {
        InitVaultFixed v = new InitVaultFixed();
        _initVault(address(v));
        InitExploit e = new InitExploit{value: 1 ether}(address(v));
        vm.expectRevert(bytes("already initialized"));
        e.run();
        assertTrue(_initHolds(address(v)));
        assertEq(v.owner(), DEPLOYER);
    }

    // ---------- share-vault ----------
    uint256[2] later = [uint256(2 ether), 0.5 ether];

    /// Honest A and B deposit after the attack and redeem everything; returns whether each got >= 99%.
    function _shareHolds(address v) internal returns (bool ok) {
        address[2] memory who = [users[0], users[1]];
        uint256[2] memory got;
        for (uint256 i; i < 2; i++) {
            vm.deal(who[i], later[i]);
            vm.prank(who[i]);
            IShare(v).deposit{value: later[i]}();
        }
        for (uint256 i; i < 2; i++) {
            uint256 s = IShare(v).sharesOf(who[i]);
            if (s == 0) continue;
            vm.prank(who[i]);
            got[i] = IShare(v).redeem(s);
        }
        ok = true;
        for (uint256 i; i < 2; i++) {
            if (got[i] * 100 < later[i] * 99) ok = false;
        }
    }

    function test_shareVault_honestFlowHoldsOnBoth() public {
        assertTrue(_shareHolds(address(new ShareVaultVuln())));
        assertTrue(_shareHolds(address(new ShareVaultFixed())));
    }

    function test_shareVault_referenceBreaksVulnerable() public {
        ShareVaultVuln v = new ShareVaultVuln();
        new ShareExploit{value: 1 ether}(address(v)).run();
        assertEq(v.totalShares(), 1);
        assertFalse(_shareHolds(address(v)));
    }

    function test_shareVault_referenceFailsOnPatched() public {
        ShareVaultFixed v = new ShareVaultFixed();
        new ShareExploit{value: 1 ether}(address(v)).run();
        assertTrue(_shareHolds(address(v)));
    }

    /// Fuzz: any split of the attacker's 1 ether between a first deposit and a donation leaves
    /// the later honest depositors whole (>= 99%) on the patched vault.
    function testFuzz_shareVault_patchedResistsInflation(uint256 first) public {
        first = bound(first, 1, 1 ether - 1);
        ShareVaultFixed v = new ShareVaultFixed();
        v.deposit{value: first}();
        new DonorT{value: 1 ether - first}(payable(address(v)));
        assertTrue(_shareHolds(address(v)));
    }

    // ---------- token-vault ----------
    function _seedToken(address v) internal {
        ILegacy t = ILegacy(ITokenVaultLike(v).token());
        for (uint256 i; i < 3; i++) {
            vm.deal(users[i], seeds[i]);
            vm.startPrank(users[i]);
            t.deposit{value: seeds[i]}();
            t.approve(v, seeds[i]);
            ITokenVaultLike(v).deposit(seeds[i]);
            vm.stopPrank();
        }
    }

    function _tokenHolds(address v) internal view returns (bool) {
        ILegacy t = ILegacy(ITokenVaultLike(v).token());
        return t.balanceOf(v) >= ITokenVaultLike(v).totalDeposits();
    }

    function test_tokenVault_referenceBreaksVulnerable() public {
        TokenVaultVuln v = new TokenVaultVuln();
        _seedToken(address(v));
        new TokenExploit{value: 1 ether}(address(v)).run();
        assertFalse(_tokenHolds(address(v)));
    }

    function test_tokenVault_referenceFailsOnPatched() public {
        TokenVaultFixed v = new TokenVaultFixed();
        _seedToken(address(v));
        TokenExploit e = new TokenExploit{value: 1 ether}(address(v));
        vm.expectRevert(bytes("token transferFrom failed"));
        e.run();
        assertTrue(_tokenHolds(address(v)));
    }

    receive() external payable {}
}
